//! `observation.recorded` (M22.1): the tagged Observation wrapper and its
//! five payload variants.
//!
//! The payload is a TAGGED union, never a flat optional-field bag — a
//! snapshot cannot fabricate an assertion to pass validation (the exact bug
//! the tagging exists to prevent). The wrapper keeps `payload` as raw JSON
//! so the body struct itself stays `deny_unknown_fields`; `validate()`
//! parses the payload for the declared `observation_kind` and re-runs the
//! canonical byte gate on it, which is what refuses unknown or smuggled
//! fields inside the flattened assertion form.

use serde::{Deserialize, Serialize};

use super::normalize::normalize_alias_v1;
use super::subject::{validate_lineage, LineageEdge, SubjectRef};
use super::value::{validate_field_path, TypedValue};
use super::{
    belief::{RelationAction, RelationKind},
    source::{AuthorityCapability, SourceRegistration},
};
use super::{canonical_json, is_id128, is_sha256, schema_body};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    SourceSnapshot,
    SystemEvent,
    ExtractedAssertion,
    DerivedContent,
    HumanAssertion,
}

impl ObservationKind {
    pub fn is_assertion(&self) -> bool {
        matches!(
            self,
            ObservationKind::ExtractedAssertion
                | ObservationKind::DerivedContent
                | ObservationKind::HumanAssertion
        )
    }
}

/// Labeled source-context strings — all optional, all display/lineage
/// context, none of them ordering or authority.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub source_system: Option<String>,
    pub source_location: Option<String>,
    pub source_record_id: Option<String>,
    pub source_revision: Option<String>,
    pub source_author: Option<String>,
    pub source_workflow_state: Option<String>,
}

impl Provenance {
    pub fn empty() -> Provenance {
        Provenance {
            source_system: None,
            source_location: None,
            source_record_id: None,
            source_revision: None,
            source_author: None,
            source_workflow_state: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssertionKind {
    Presence,
    Absence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Planned,
    Approved,
    Implemented,
    Validated,
    Deployed,
    Shipping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub stage: Option<Stage>,
    pub revision: Option<String>,
    pub environment: Option<String>,
    pub geography: Option<String>,
}

impl Scope {
    pub fn empty() -> Scope {
        Scope {
            stage: None,
            revision: None,
            environment: None,
            geography: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubjectRole {
    ProjectOwner,
    TeamMember,
    Adjacent,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelationshipToSubject {
    pub role: SubjectRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssertionBasis {
    Firsthand,
    ResponsibleOwner,
    Reported,
    Inferred,
    Unknown,
}

/// Derived by the core from the pinned registration and trusted call path.
/// An agent cannot choose or upgrade it; relationship/basis fields on
/// `agent_inferred` content remain claims, not authority proof (D11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityProvenance {
    TrustedHumanCapture,
    RegisteredDirectArtifact,
    AgentInferred,
}

/// The structural absence record (§53): an absence claim without its search
/// story is schema-rejected. Coverage-reference ENFORCEMENT waits for M24.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AbsenceRecord {
    pub searched_domain: String,
    pub search_scope: String,
    pub coverage_basis: String,
    pub observation_window: String,
    pub query_strategy: String,
    pub limitations: String,
}

/// The assertion fields shared by the three assertion variants. Illegal on
/// snapshots and system events — those payload structs simply do not have
/// them, and `deny_unknown_fields` refuses a smuggle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssertionFields {
    pub assertion_kind: AssertionKind,
    pub predicate: String,
    pub value: TypedValue,
    pub scope: Scope,
    pub relationship_to_subject: RelationshipToSubject,
    pub assertion_basis: AssertionBasis,
    pub authority_provenance: AuthorityProvenance,
    pub absence: Option<AbsenceRecord>,
}

impl AssertionFields {
    fn validate(&self) -> Result<(), String> {
        if self.predicate.is_empty() {
            return Err("assertion predicate must be non-empty".into());
        }
        self.value.validate()?;
        match (self.assertion_kind, &self.absence) {
            (AssertionKind::Absence, Some(record)) => {
                let fields = [
                    ("searched_domain", &record.searched_domain),
                    ("search_scope", &record.search_scope),
                    ("coverage_basis", &record.coverage_basis),
                    ("observation_window", &record.observation_window),
                    ("query_strategy", &record.query_strategy),
                    ("limitations", &record.limitations),
                ];
                for (name, value) in fields {
                    if value.is_empty() {
                        return Err(format!(
                            "absence assertion needs a complete structural record — {name} is empty"
                        ));
                    }
                }
            }
            (AssertionKind::Absence, None) => {
                return Err("absence assertion lacks its structural absence record".into())
            }
            (AssertionKind::Presence, Some(_)) => {
                return Err("presence assertion cannot carry an absence record".into())
            }
            (AssertionKind::Presence, None) => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceSnapshotPayload {
    /// D7 content addressing over the captured artifact bytes; null = an
    /// unsnapshotted reference (D8) — recorded, never fabricated.
    pub source_artifact_hash: Option<String>,
    pub raw_pointer: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemEventPayload {
    pub event_type: String,
    pub detail: TypedValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedAssertionPayload {
    #[serde(flatten)]
    pub assertion: AssertionFields,
    pub extracted_text: String,
    pub source_artifact_hash: String,
    pub extractor_version: String,
    pub raw_pointer: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DerivedContentPayload {
    #[serde(flatten)]
    pub assertion: AssertionFields,
    pub rendered_text: String,
    pub generator_version: String,
    /// Explicit Belief-revision inputs for M26 self-ancestry. Omission means
    /// no Belief input; present means non-empty, sorted, duplicate-free,
    /// naming earlier committed creations/revisions (reduce-time). The
    /// reducer indexes these READ-ONLY — never independent support.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_belief_revision_event_ids: Option<Vec<String>>,
}

/// The exact human-input union. Alias REMOVAL has no M22 event and is an
/// unsupported transition, never an override.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "assertion_form", rename_all = "snake_case")]
pub enum HumanAssertionForm {
    FieldChange {
        target_belief_id: String,
        field_path: String,
        before: TypedValue,
        after: TypedValue,
        corrects: Option<String>,
        reason: Option<String>,
    },
    RelationChange {
        target_belief_id: String,
        relation_id: String,
        action: RelationAction,
        from: String,
        to: String,
        relation: RelationKind,
        corrects: Option<String>,
        reason: Option<String>,
    },
    AliasAdd {
        target_belief_id: String,
        entity_id: String,
        alias: String,
        normalized_alias: String,
        corrects: Option<String>,
        reason: Option<String>,
    },
    Standalone {
        intended_belief_id: Option<String>,
        corrects: Option<String>,
        reason: Option<String>,
    },
}

impl HumanAssertionForm {
    fn corrects(&self) -> Option<&str> {
        match self {
            HumanAssertionForm::FieldChange { corrects, .. }
            | HumanAssertionForm::RelationChange { corrects, .. }
            | HumanAssertionForm::AliasAdd { corrects, .. }
            | HumanAssertionForm::Standalone { corrects, .. } => corrects.as_deref(),
        }
    }

    fn reason(&self) -> Option<&str> {
        match self {
            HumanAssertionForm::FieldChange { reason, .. }
            | HumanAssertionForm::RelationChange { reason, .. }
            | HumanAssertionForm::AliasAdd { reason, .. }
            | HumanAssertionForm::Standalone { reason, .. } => reason.as_deref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HumanAssertionPayload {
    #[serde(flatten)]
    pub assertion: AssertionFields,
    #[serde(flatten)]
    pub form: HumanAssertionForm,
}

/// The typed view `validate()` returns once the raw payload has passed the
/// per-kind parse and canonical gate.
#[derive(Debug, Clone, PartialEq)]
pub enum ObservationPayload {
    SourceSnapshot(SourceSnapshotPayload),
    SystemEvent(SystemEventPayload),
    ExtractedAssertion(ExtractedAssertionPayload),
    DerivedContent(DerivedContentPayload),
    HumanAssertion(HumanAssertionPayload),
}

impl ObservationPayload {
    pub fn assertion(&self) -> Option<&AssertionFields> {
        match self {
            ObservationPayload::ExtractedAssertion(p) => Some(&p.assertion),
            ObservationPayload::DerivedContent(p) => Some(&p.assertion),
            ObservationPayload::HumanAssertion(p) => Some(&p.assertion),
            _ => None,
        }
    }
}

schema_body! {
    /// The Observation wrapper. `source_id` is opaque per-store hex128 for a
    /// logical origin — not a provider, record, or revision id — and every
    /// Observation pins the earlier (or same-batch) registration event that
    /// established it.
    pub struct ObservationRecorded {
        pub observation_kind: ObservationKind,
        pub source_id: String,
        pub source_registration_event_id: String,
        pub subject: SubjectRef,
        pub lineage: Vec<LineageEdge>,
        pub provenance: Provenance,
        pub payload: serde_json::Value,
    }
}

impl ObservationRecorded {
    /// Structural validation; returns the typed payload on success.
    pub fn validate(&self) -> Result<ObservationPayload, String> {
        self.validate_common()?;
        if !is_id128(&self.source_id) {
            return Err(format!(
                "source_id {:?} is not stable-form 128-bit lowercase hex",
                self.source_id
            ));
        }
        if !is_id128(&self.source_registration_event_id) {
            return Err("source_registration_event_id is not a 128-bit hex event id".into());
        }
        self.subject.validate()?;
        validate_lineage(&self.lineage)?;

        // Parse the payload for the declared kind, then the byte gate: a
        // payload we would not re-emit identically is not canonical.
        fn gate<T: serde::de::DeserializeOwned + Serialize>(
            raw: &serde_json::Value,
        ) -> Result<T, String> {
            let typed: T =
                serde_json::from_value(raw.clone()).map_err(|e| format!("payload: {e}"))?;
            if canonical_json(&typed)? != canonical_json(raw)? {
                return Err(
                    "payload is not canonical for its observation_kind (unknown or reordered \
                     fields survive a round trip only as different bytes)"
                        .into(),
                );
            }
            Ok(typed)
        }

        let payload = match self.observation_kind {
            ObservationKind::SourceSnapshot => {
                ObservationPayload::SourceSnapshot(gate::<SourceSnapshotPayload>(&self.payload)?)
            }
            ObservationKind::SystemEvent => {
                ObservationPayload::SystemEvent(gate::<SystemEventPayload>(&self.payload)?)
            }
            ObservationKind::ExtractedAssertion => {
                ObservationPayload::ExtractedAssertion(gate::<ExtractedAssertionPayload>(
                    &self.payload,
                )?)
            }
            ObservationKind::DerivedContent => {
                ObservationPayload::DerivedContent(gate::<DerivedContentPayload>(&self.payload)?)
            }
            ObservationKind::HumanAssertion => {
                ObservationPayload::HumanAssertion(gate::<HumanAssertionPayload>(&self.payload)?)
            }
        };

        // Subject boundaries: assertions need a real (possibly unresolved)
        // subject; snapshots and system events may say none.
        if self.observation_kind.is_assertion() && self.subject.is_none() {
            return Err(
                "assertion subject cannot be none — resolved or unresolved, never invented".into(),
            );
        }

        match &payload {
            ObservationPayload::SourceSnapshot(p) => {
                if let Some(hash) = &p.source_artifact_hash {
                    if !is_sha256(hash) {
                        return Err("source_artifact_hash is not SHA-256 hex".into());
                    }
                }
                if p.raw_pointer.is_empty() {
                    return Err("snapshot raw_pointer must be non-empty".into());
                }
            }
            ObservationPayload::SystemEvent(p) => {
                if p.event_type.is_empty() {
                    return Err("system_event event_type must be non-empty".into());
                }
                p.detail.validate()?;
            }
            ObservationPayload::ExtractedAssertion(p) => {
                p.assertion.validate()?;
                if self.lineage.is_empty() {
                    return Err(
                        "extracted_assertion requires Observation lineage (§43) — an extraction \
                         with no parent is a fabrication"
                            .into(),
                    );
                }
                if !is_sha256(&p.source_artifact_hash) {
                    return Err("extracted_assertion source_artifact_hash is not SHA-256".into());
                }
                if p.extractor_version.is_empty() || p.raw_pointer.is_empty() {
                    return Err(
                        "extracted_assertion needs extractor_version and raw_pointer".into(),
                    );
                }
            }
            ObservationPayload::DerivedContent(p) => {
                p.assertion.validate()?;
                if p.generator_version.is_empty() {
                    return Err("derived_content needs a generator_version".into());
                }
                let belief_inputs = p.source_belief_revision_event_ids.as_deref().unwrap_or(&[]);
                if self.lineage.is_empty() && belief_inputs.is_empty() {
                    return Err(
                        "derived_content needs at least one Observation or Belief-revision parent \
                         (§43)"
                            .into(),
                    );
                }
                if matches!(p.source_belief_revision_event_ids.as_deref(), Some([])) {
                    return Err(
                        "source_belief_revision_event_ids present means non-empty — omit it \
                         instead"
                            .into(),
                    );
                }
                for pair in belief_inputs.windows(2) {
                    if pair[0] >= pair[1] {
                        return Err(
                            "source_belief_revision_event_ids must be sorted and duplicate-free"
                                .into(),
                        );
                    }
                }
                if let Some(bad) = belief_inputs.iter().find(|id| !is_id128(id)) {
                    return Err(format!("belief-revision source {bad:?} is not an event id"));
                }
            }
            ObservationPayload::HumanAssertion(p) => {
                p.assertion.validate()?;
                self.validate_human_form(p)?;
            }
        }

        // Structural authority boundaries; the registration-derived check is
        // reduce-time (`derive_authority`).
        if let Some(assertion) = payload.assertion() {
            match assertion.authority_provenance {
                AuthorityProvenance::TrustedHumanCapture
                    if self.observation_kind != ObservationKind::HumanAssertion =>
                {
                    return Err(
                        "trusted_human_capture exists only on human_assertion observations".into(),
                    )
                }
                AuthorityProvenance::RegisteredDirectArtifact
                    if self.observation_kind != ObservationKind::ExtractedAssertion =>
                {
                    return Err(
                        "registered_direct_artifact exists only on extracted_assertion \
                         observations"
                            .into(),
                    )
                }
                _ => {}
            }
        }

        Ok(payload)
    }

    fn validate_human_form(&self, payload: &HumanAssertionPayload) -> Result<(), String> {
        let form = &payload.form;
        // Correction constraints shared by every form: a correction names
        // its mistake and its reason.
        if let Some(corrects) = form.corrects() {
            if !is_id128(corrects) {
                return Err("corrects must name an Observation event id".into());
            }
            match form.reason() {
                Some(reason) if !reason.is_empty() => {}
                _ => return Err("a correction requires a non-empty reason".into()),
            }
        }
        if form.reason() == Some("") {
            return Err("reason must be null or non-empty".into());
        }

        match form {
            HumanAssertionForm::FieldChange {
                target_belief_id,
                field_path,
                before,
                after,
                ..
            } => {
                if !is_id128(target_belief_id) {
                    return Err("field_change target_belief_id is not a stable id".into());
                }
                validate_field_path(field_path)?;
                before.validate()?;
                after.validate()?;
            }
            HumanAssertionForm::RelationChange {
                target_belief_id,
                relation_id,
                action,
                from,
                to,
                relation,
                ..
            } => {
                for (name, id) in [
                    ("target_belief_id", target_belief_id),
                    ("relation_id", relation_id),
                    ("from", from),
                    ("to", to),
                ] {
                    if !is_id128(id) {
                        return Err(format!("relation_change {name} is not a stable id"));
                    }
                }
                if target_belief_id != from {
                    return Err("relation_change targets the `from` Belief".into());
                }
                if payload.assertion.predicate != "belief_relation" {
                    return Err("relation_change predicate must be belief_relation".into());
                }
                // The typed value must BE the canonical relation object,
                // pairing one-to-one with the exact belief.relation event.
                let want = expect_object(&[
                    ("relation_id", relation_id),
                    ("action", action_str(*action)),
                    ("from", from),
                    ("to", to),
                    ("relation", relation_str(*relation)),
                ]);
                // Byte comparison, not map equality — canonical key ORDER is
                // part of the pairing contract.
                if canonical_json(&payload.assertion.value)? != canonical_json(&want)? {
                    return Err(
                        "relation_change value must be the canonical {relation_id, action, from, \
                         to, relation} object"
                            .into(),
                    );
                }
            }
            HumanAssertionForm::AliasAdd {
                target_belief_id,
                entity_id,
                alias,
                normalized_alias,
                ..
            } => {
                if !is_id128(target_belief_id) || !is_id128(entity_id) {
                    return Err("alias_add needs stable belief and entity ids".into());
                }
                if alias.is_empty() {
                    return Err("alias_add alias must be a non-empty source string".into());
                }
                if *normalized_alias != normalize_alias_v1(alias) {
                    return Err(
                        "alias_add normalized_alias does not match normalize_alias_v1".into(),
                    );
                }
                if payload.assertion.predicate != "entity_alias" {
                    return Err("alias_add predicate must be entity_alias".into());
                }
                let want = expect_object(&[
                    ("entity_id", entity_id),
                    ("alias", alias),
                    ("normalized_alias", normalized_alias),
                ]);
                if canonical_json(&payload.assertion.value)? != canonical_json(&want)? {
                    return Err("alias_add value must be the canonical {entity_id, alias, \
                         normalized_alias} object"
                        .into());
                }
            }
            HumanAssertionForm::Standalone {
                intended_belief_id, ..
            } => {
                if let Some(id) = intended_belief_id {
                    if !is_id128(id) {
                        return Err("standalone intended_belief_id is not a stable id".into());
                    }
                }
            }
        }
        Ok(())
    }
}

fn action_str(action: RelationAction) -> &'static str {
    match action {
        RelationAction::Add => "add",
        RelationAction::Remove => "remove",
    }
}

fn relation_str(relation: RelationKind) -> &'static str {
    match relation {
        RelationKind::Supersedes => "supersedes",
        RelationKind::Refines => "refines",
        RelationKind::Contradicts => "contradicts",
    }
}

fn expect_object(pairs: &[(&str, &str)]) -> TypedValue {
    TypedValue::Object {
        value: pairs
            .iter()
            .map(|(k, v)| (k.to_string(), TypedValue::string(v)))
            .collect(),
    }
}

/// The core's authority derivation (D11), pure over the pinned registration:
/// `trusted_human_capture` needs a human_actor registration whose actor IS
/// the observation's actor, capability human_assertion, and a
/// human_assertion observation; `registered_direct_artifact` needs an
/// extracted_assertion whose registration capability is
/// direct_system_artifact; everything else is agent_inferred. Payload fields
/// cannot elevate agent-inferred content.
pub fn derive_authority(
    registration: &SourceRegistration,
    observation_actor: &str,
    observation_kind: ObservationKind,
) -> AuthorityProvenance {
    match registration {
        SourceRegistration::HumanActor { actor_id, .. }
            if registration.capability() == AuthorityCapability::HumanAssertion
                && actor_id == observation_actor
                && observation_kind == ObservationKind::HumanAssertion =>
        {
            AuthorityProvenance::TrustedHumanCapture
        }
        _ if registration.capability() == AuthorityCapability::DirectSystemArtifact
            && observation_kind == ObservationKind::ExtractedAssertion =>
        {
            AuthorityProvenance::RegisteredDirectArtifact
        }
        _ => AuthorityProvenance::AgentInferred,
    }
}

#[cfg(test)]
mod tests {
    use super::super::source::tests::registration;
    use super::super::subject::LineageKind;
    use super::super::tests::{common, observation_recorded, ID_A, ID_B};
    use super::*;

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

    #[test]
    fn a_snapshot_with_assertion_fields_is_refused() {
        let mut event = observation_recorded(ObservationKind::SourceSnapshot);
        event.payload = serde_json::json!({
            "source_artifact_hash": null,
            "raw_pointer": "docs/source.md",
            "assertion_kind": "presence"
        });
        let err = event.validate().unwrap_err();
        assert!(
            err.contains("unknown field") || err.contains("canonical"),
            "{err}"
        );
    }

    #[test]
    fn assertion_subject_none_is_refused_unresolved_accepted() {
        let mut event = observation_recorded(ObservationKind::ExtractedAssertion);
        event.subject = SubjectRef::None;
        assert!(event.validate().unwrap_err().contains("cannot be none"));

        let mut event = observation_recorded(ObservationKind::ExtractedAssertion);
        event.subject = SubjectRef::Unresolved {
            raw_ref: "Acme".into(),
            aliases: vec!["Acme Corp".into()],
        };
        event.validate().unwrap();
    }

    #[test]
    fn snapshots_and_system_events_may_have_no_subject() {
        for kind in [
            ObservationKind::SourceSnapshot,
            ObservationKind::SystemEvent,
        ] {
            let event = observation_recorded(kind);
            assert!(event.subject.is_none());
            event.validate().unwrap();
        }
    }

    #[test]
    fn extraction_without_lineage_is_a_fabrication() {
        let mut event = observation_recorded(ObservationKind::ExtractedAssertion);
        event.lineage.clear();
        assert!(event.validate().unwrap_err().contains("lineage"));
    }

    #[test]
    fn derived_content_needs_some_parent_and_sorted_belief_sources() {
        let mut event = observation_recorded(ObservationKind::DerivedContent);
        event.lineage.clear();
        assert!(event.validate().is_err(), "no parent at all");

        // A belief-revision source alone satisfies the parent rule.
        let mut event = observation_recorded(ObservationKind::DerivedContent);
        event.lineage.clear();
        let mut payload: DerivedContentPayload =
            serde_json::from_value(event.payload.clone()).unwrap();
        payload.source_belief_revision_event_ids = Some(vec![ID_B.into()]);
        event.payload = serde_json::to_value(&payload).unwrap();
        event.validate().unwrap();

        // Unsorted or duplicated sources are refused.
        for bad in [
            vec![ID_B.into(), ID_A.into()],
            vec![ID_A.into(), ID_A.into()],
        ] {
            let mut payload = payload.clone();
            payload.source_belief_revision_event_ids = Some(bad);
            let mut event = event.clone();
            event.payload = serde_json::to_value(&payload).unwrap();
            assert!(event.validate().unwrap_err().contains("sorted"));
        }

        // Present-but-empty is refused: omission is the encoding for none.
        let raw = serde_json::to_value(&payload).unwrap();
        let mut with_empty = raw.as_object().unwrap().clone();
        with_empty["source_belief_revision_event_ids"] = serde_json::json!([]);
        let mut event = event.clone();
        event.payload = serde_json::Value::Object(with_empty);
        assert!(event.validate().is_err());
    }

    #[test]
    fn absence_needs_its_complete_record_and_presence_refuses_one() {
        let mut fields = assertion_fields(AuthorityProvenance::AgentInferred);
        fields.assertion_kind = AssertionKind::Absence;
        assert!(fields.validate().unwrap_err().contains("absence record"));

        fields.absence = Some(AbsenceRecord {
            searched_domain: "tickets".into(),
            search_scope: "project-x".into(),
            coverage_basis: "full index".into(),
            observation_window: "2026-07".into(),
            query_strategy: "exact + fuzzy".into(),
            limitations: String::new(),
        });
        assert!(fields.validate().unwrap_err().contains("limitations"));

        if let Some(record) = &mut fields.absence {
            record.limitations = "archived tickets unscanned".into();
        }
        fields.validate().unwrap();

        fields.assertion_kind = AssertionKind::Presence;
        assert!(fields.validate().unwrap_err().contains("presence"));
    }

    #[test]
    fn human_forms_validate_their_exact_pairing_objects() {
        // The field_change fixture validates as-is.
        let event = observation_recorded(ObservationKind::HumanAssertion);
        event.validate().unwrap();

        // relation_change: value must equal the canonical relation object.
        let relation_form = HumanAssertionForm::RelationChange {
            target_belief_id: ID_A.into(),
            relation_id: super::super::derive_relation_id(ID_A, ID_B, RelationKind::Refines),
            action: RelationAction::Add,
            from: ID_A.into(),
            to: ID_B.into(),
            relation: RelationKind::Refines,
            corrects: None,
            reason: None,
        };
        let mut fields = assertion_fields(AuthorityProvenance::TrustedHumanCapture);
        fields.predicate = "belief_relation".into();
        fields.value = TypedValue::string("wrong");
        let mut event = observation_recorded(ObservationKind::HumanAssertion);
        event.payload = serde_json::to_value(&HumanAssertionPayload {
            assertion: fields.clone(),
            form: relation_form.clone(),
        })
        .unwrap();
        assert!(event.validate().unwrap_err().contains("canonical"));

        // With the exact canonical object it passes.
        let relation_id = super::super::derive_relation_id(ID_A, ID_B, RelationKind::Refines);
        fields.value = expect_object(&[
            ("relation_id", relation_id.as_str()),
            ("action", "add"),
            ("from", ID_A),
            ("to", ID_B),
            ("relation", "refines"),
        ]);
        event.payload = serde_json::to_value(&HumanAssertionPayload {
            assertion: fields,
            form: relation_form,
        })
        .unwrap();
        event.validate().unwrap();
    }

    #[test]
    fn alias_add_normalization_and_pairing_are_checked() {
        let mut fields = assertion_fields(AuthorityProvenance::TrustedHumanCapture);
        fields.predicate = "entity_alias".into();
        fields.value = expect_object(&[
            ("entity_id", ID_B),
            ("alias", "Acme  Corp"),
            ("normalized_alias", "acme corp"),
        ]);
        let form = HumanAssertionForm::AliasAdd {
            target_belief_id: ID_A.into(),
            entity_id: ID_B.into(),
            alias: "Acme  Corp".into(),
            normalized_alias: "acme corp".into(),
            corrects: None,
            reason: None,
        };
        let mut event = observation_recorded(ObservationKind::HumanAssertion);
        event.payload = serde_json::to_value(&HumanAssertionPayload {
            assertion: fields.clone(),
            form: form.clone(),
        })
        .unwrap();
        event.validate().unwrap();

        // Wrong normalized key: refused.
        let bad_form = HumanAssertionForm::AliasAdd {
            target_belief_id: ID_A.into(),
            entity_id: ID_B.into(),
            alias: "Acme  Corp".into(),
            normalized_alias: "Acme  Corp".into(),
            corrects: None,
            reason: None,
        };
        let mut bad_fields = fields.clone();
        bad_fields.value = expect_object(&[
            ("entity_id", ID_B),
            ("alias", "Acme  Corp"),
            ("normalized_alias", "Acme  Corp"),
        ]);
        event.payload = serde_json::to_value(&HumanAssertionPayload {
            assertion: bad_fields,
            form: bad_form,
        })
        .unwrap();
        assert!(event.validate().unwrap_err().contains("normalize_alias_v1"));
    }

    #[test]
    fn corrections_need_reasons_and_standalone_may_be_unattached() {
        let mut event = observation_recorded(ObservationKind::HumanAssertion);
        let standalone = HumanAssertionPayload {
            assertion: assertion_fields(AuthorityProvenance::TrustedHumanCapture),
            form: HumanAssertionForm::Standalone {
                intended_belief_id: None,
                corrects: Some(ID_B.into()),
                reason: None,
            },
        };
        event.payload = serde_json::to_value(&standalone).unwrap();
        assert!(event.validate().unwrap_err().contains("reason"));

        let ok = HumanAssertionPayload {
            form: HumanAssertionForm::Standalone {
                intended_belief_id: None,
                corrects: Some(ID_B.into()),
                reason: Some("mis-heard the owner".into()),
            },
            ..standalone
        };
        event.payload = serde_json::to_value(&ok).unwrap();
        event.validate().unwrap();
    }

    #[test]
    fn authority_derivation_is_closed_and_never_caller_elevated() {
        let human = registration("human_actor");
        let direct = registration("connector"); // direct_system_artifact fixture
        let content = registration("builtin"); // content_only fixture
        let legacy = registration("legacy_reference");

        assert_eq!(
            derive_authority(&human, "human:josef", ObservationKind::HumanAssertion),
            AuthorityProvenance::TrustedHumanCapture
        );
        // Wrong actor, wrong kind: never trusted capture.
        assert_eq!(
            derive_authority(&human, "agent:run-1", ObservationKind::HumanAssertion),
            AuthorityProvenance::AgentInferred
        );
        assert_eq!(
            derive_authority(&human, "human:josef", ObservationKind::ExtractedAssertion),
            AuthorityProvenance::AgentInferred
        );
        assert_eq!(
            derive_authority(&direct, "agent:run-1", ObservationKind::ExtractedAssertion),
            AuthorityProvenance::RegisteredDirectArtifact
        );
        // Direct capability on a non-extraction is not direct authority.
        assert_eq!(
            derive_authority(&direct, "agent:run-1", ObservationKind::DerivedContent),
            AuthorityProvenance::AgentInferred
        );
        // Content-only and legacy can never be anything but inferred.
        assert_eq!(
            derive_authority(&content, "agent:run-1", ObservationKind::ExtractedAssertion),
            AuthorityProvenance::AgentInferred
        );
        assert_eq!(
            derive_authority(&legacy, "agent:run-1", ObservationKind::ExtractedAssertion),
            AuthorityProvenance::AgentInferred
        );
    }

    #[test]
    fn structural_authority_boundaries_hold() {
        // trusted_human_capture on an extraction: refused before any lookup.
        let mut event = observation_recorded(ObservationKind::ExtractedAssertion);
        let mut payload: ExtractedAssertionPayload =
            serde_json::from_value(event.payload.clone()).unwrap();
        payload.assertion.authority_provenance = AuthorityProvenance::TrustedHumanCapture;
        event.payload = serde_json::to_value(&payload).unwrap();
        assert!(event.validate().unwrap_err().contains("human_assertion"));

        // registered_direct_artifact on derived content: same.
        let mut event = observation_recorded(ObservationKind::DerivedContent);
        let mut payload: DerivedContentPayload =
            serde_json::from_value(event.payload.clone()).unwrap();
        payload.assertion.authority_provenance = AuthorityProvenance::RegisteredDirectArtifact;
        event.payload = serde_json::to_value(&payload).unwrap();
        assert!(event
            .validate()
            .unwrap_err()
            .contains("extracted_assertion"));
    }

    #[test]
    fn duplicate_lineage_parents_are_refused_via_the_wrapper() {
        let mut event = observation_recorded(ObservationKind::ExtractedAssertion);
        event.lineage = vec![
            LineageEdge {
                edge: LineageKind::ReportedBy,
                parent_observation_event_id: ID_B.into(),
            },
            LineageEdge {
                edge: LineageKind::DerivedFrom,
                parent_observation_event_id: ID_B.into(),
            },
        ];
        assert!(event.validate().unwrap_err().contains("duplicate"));
    }

    #[test]
    fn the_wrapper_pins_actor_and_ids() {
        let mut event = observation_recorded(ObservationKind::SourceSnapshot);
        event.source_id = "UPPER0000000000000000000000000000".into();
        assert!(event.validate().is_err());

        let mut event = observation_recorded(ObservationKind::SourceSnapshot);
        event.actor = common("").1;
        assert!(event.validate().is_err());
    }
}
