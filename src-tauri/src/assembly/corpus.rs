//! What an assembly is allowed to SHOW (M26.5c).
//!
//! The reducer's `EpistemicState` holds every relationship an assembly needs
//! to *select* things — which beliefs are about what, which contradict which,
//! which observation supports which revision. It deliberately does not hold
//! the assertions' prose: state is a projection, and keeping every payload in
//! it would make the projection as large as the ledger.
//!
//! So selection reads state and rendering reads here, and this module is the
//! only place assertion bytes enter an assembly. Two consequences worth
//! stating, because both are load-bearing:
//!
//! **No raw source text, ever.** An assertion renders as its CLAIM — the
//! predicate and the typed value the extractor committed — never as
//! `extracted_text` or `rendered_text`, which are the source's own bytes. A
//! manifest is persisted and re-read; a manifest that carried source prose
//! would spread tainted bytes into the runtime DB and into every surface that
//! displays one, and §92's fencing problem would grow a new front for no gain.
//! The claim is what the base actually holds, which is also what the question
//! is entitled to be shown.
//!
//! **Rendered once, measured from the rendering.** `max_context_bytes` is a
//! promise about what a run is shown, and the only way to keep it honest is
//! for the number in the manifest and the text in the prompt to come from the
//! same string. [`Assertion::statement`] is that string; the manifest's
//! `byte_count` and `content_hash` are computed over it, and M26.5e's prompt
//! prints its fence-safe image (normalized and capped, M31.3b — longer than
//! the counted bytes only by the truncation mark, when the cap fires).

use std::collections::BTreeMap;

use crate::ledger::frame::Frame;
use crate::ledger::schema::{
    decode_body, AssertionFields, AssertionKind, EventBody, Scope, TypedValue,
};

/// One assertion, as an assembly would show it.
#[derive(Debug, Clone, PartialEq)]
pub struct Assertion {
    pub event_id: String,
    /// The claim, rendered. See the module note: never the source's bytes.
    pub statement: String,
    pub scope: Scope,
    /// The event's declared validity window. Carried because a manifest item
    /// has to say WHEN a claim was true, and the reducer's state drops it —
    /// an assembly that defaulted every item to unbounded would report a
    /// lapsed claim as a standing one.
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
}

/// Every assertion a store's ledger holds, by Observation event id.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Corpus {
    assertions: BTreeMap<String, Assertion>,
}

impl Corpus {
    /// Read the assertions out of a ledger's frames.
    ///
    /// A frame this build cannot decode is SKIPPED rather than fatal: a
    /// forward-version event in the middle of the log would otherwise make
    /// every question in the vault unanswerable, and an assertion nobody can
    /// read is one the assembly simply never selects — which the manifest then
    /// records as candidates not found, rather than as an answer built on a
    /// set it silently mis-sized.
    pub fn from_frames(frames: &[Frame]) -> Corpus {
        let mut assertions = BTreeMap::new();
        for frame in frames {
            let Ok(Some(EventBody::ObservationRecorded(body))) =
                decode_body(&frame.kind, &frame.body)
            else {
                continue;
            };
            if !body.observation_kind.is_assertion() {
                continue;
            }
            let Ok(payload) = body.validate() else {
                continue;
            };
            let Some(fields) = payload.assertion() else {
                continue;
            };
            assertions.insert(
                frame.event_id.clone(),
                Assertion {
                    event_id: frame.event_id.clone(),
                    statement: render(fields),
                    scope: fields.scope.clone(),
                    valid_from: body.valid_from.clone(),
                    valid_to: body.valid_to.clone(),
                },
            );
        }
        Corpus { assertions }
    }

    pub fn get(&self, event_id: &str) -> Option<&Assertion> {
        self.assertions.get(event_id)
    }

    pub fn len(&self) -> usize {
        self.assertions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.assertions.is_empty()
    }

    /// Used by tests and by callers assembling from a set they already hold.
    pub fn insert(&mut self, assertion: Assertion) {
        self.assertions
            .insert(assertion.event_id.clone(), assertion);
    }
}

/// The claim as one line.
///
/// An absence renders as an absence. `"{predicate}: {value}"` for a claim that
/// the base recorded as "we looked and there is none" would read as a positive
/// claim about an empty value, which is the exact confusion §53's structural
/// absence record exists to prevent.
fn render(fields: &AssertionFields) -> String {
    match fields.assertion_kind {
        AssertionKind::Presence => {
            format!("{}: {}", fields.predicate, render_value(&fields.value))
        }
        AssertionKind::Absence => {
            let searched = fields
                .absence
                .as_ref()
                .map(|record| record.searched_domain.as_str())
                .unwrap_or("an unnamed domain");
            format!("{}: none found — searched {searched}", fields.predicate)
        }
    }
}

fn render_value(value: &TypedValue) -> String {
    match value {
        // A bare string renders as itself; quoting it would put JSON syntax in
        // front of a reader for no information.
        TypedValue::String { value } => value.clone(),
        TypedValue::Missing => "(missing)".to_string(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "(unrenderable)".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::{
        AbsenceRecord, Actor, AssertionBasis, AuthorityProvenance, LineageEdge, LineageKind,
        ObservationKind, ObservationRecorded, Provenance, RelationshipToSubject, SubjectRef,
        SubjectRole,
    };

    const SOURCE: &str = "50000000000000000000000000000001";
    const REG: &str = "60000000000000000000000000000001";
    const ENTITY: &str = "e0000000000000000000000000000001";
    const PARENT: &str = "70000000000000000000000000000001";

    fn fields(kind: AssertionKind, predicate: &str, value: TypedValue) -> AssertionFields {
        AssertionFields {
            assertion_kind: kind,
            predicate: predicate.to_string(),
            value,
            scope: Scope::empty(),
            relationship_to_subject: RelationshipToSubject {
                role: SubjectRole::Unknown,
            },
            assertion_basis: AssertionBasis::Firsthand,
            authority_provenance: AuthorityProvenance::RegisteredDirectArtifact,
            absence: match kind {
                AssertionKind::Presence => None,
                AssertionKind::Absence => Some(AbsenceRecord {
                    searched_domain: "the release notes".into(),
                    search_scope: "rev C".into(),
                    coverage_basis: "the whole folder".into(),
                    observation_window: "2026-08".into(),
                    query_strategy: "every note naming the product".into(),
                    limitations: "notes only".into(),
                }),
            },
        }
    }

    fn frame(event_id: &str, kind: ObservationKind, fields: AssertionFields) -> Frame {
        let payload = match kind {
            ObservationKind::ExtractedAssertion => serde_json::json!({
                "assertion_kind": fields.assertion_kind,
                "predicate": fields.predicate,
                "value": fields.value,
                "scope": fields.scope,
                "relationship_to_subject": fields.relationship_to_subject,
                "assertion_basis": fields.assertion_basis,
                "authority_provenance": fields.authority_provenance,
                "absence": fields.absence,
                "extracted_text": "the raw bytes nobody should see downstream",
                "source_artifact_hash": "a".repeat(64),
                "extractor_version": "test-v1",
                "raw_pointer": "records/a.md#L1",
            }),
            _ => panic!("fixture covers extracted assertions"),
        };
        let body = ObservationRecorded {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "system:test".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            observation_kind: kind,
            source_id: SOURCE.into(),
            source_registration_event_id: REG.into(),
            subject: SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            // §43: an extraction with no parent Observation is a fabrication,
            // and the schema says so before this module gets a chance to.
            lineage: vec![LineageEdge {
                edge: LineageKind::DerivedFrom,
                parent_observation_event_id: PARENT.into(),
            }],
            provenance: Provenance {
                source_system: None,
                source_location: None,
                source_record_id: None,
                source_revision: None,
                source_author: None,
                source_workflow_state: None,
            },
            payload,
        };
        Frame {
            v: 1,
            seq: 1,
            event_id: event_id.to_string(),
            prev: "0".repeat(64),
            hash: "0".repeat(64),
            ingested_at: "2026-08-11T00:00:00.000Z".into(),
            wall_clock_anomaly: false,
            kind: "observation.recorded".into(),
            body: serde_json::to_value(&body).unwrap(),
        }
    }

    #[test]
    fn an_assertion_renders_as_its_claim_and_never_as_the_source_bytes() {
        // The rule the whole module exists for. `extracted_text` is in the
        // event; it must not be in the corpus.
        let corpus = Corpus::from_frames(&[frame(
            &"a".repeat(32),
            ObservationKind::ExtractedAssertion,
            fields(
                AssertionKind::Presence,
                "ship_date",
                TypedValue::string("2026-09-01"),
            ),
        )]);
        let assertion = corpus.get(&"a".repeat(32)).expect("one assertion");
        assert_eq!(assertion.statement, "ship_date: 2026-09-01");
        assert!(
            !assertion.statement.contains("raw bytes"),
            "the source's own text never enters a manifest"
        );
    }

    #[test]
    fn an_absence_renders_as_an_absence() {
        // "predicate: " with an empty value would read as a positive claim
        // about nothing, which is the confusion §53 exists to prevent.
        let corpus = Corpus::from_frames(&[frame(
            &"b".repeat(32),
            ObservationKind::ExtractedAssertion,
            fields(AssertionKind::Absence, "ship_date", TypedValue::Missing),
        )]);
        let assertion = corpus.get(&"b".repeat(32)).unwrap();
        assert_eq!(
            assertion.statement,
            "ship_date: none found — searched the release notes"
        );
    }

    #[test]
    fn a_structured_value_renders_as_canonical_json() {
        let corpus = Corpus::from_frames(&[frame(
            &"c".repeat(32),
            ObservationKind::ExtractedAssertion,
            fields(
                AssertionKind::Presence,
                "owners",
                TypedValue::Array {
                    value: vec![TypedValue::string("Ada"), TypedValue::string("Bo")],
                },
            ),
        )]);
        let statement = &corpus.get(&"c".repeat(32)).unwrap().statement;
        assert!(statement.starts_with("owners: "), "{statement}");
        assert!(statement.contains("Ada") && statement.contains("Bo"));
    }

    #[test]
    fn a_frame_this_build_cannot_read_is_skipped_rather_than_fatal() {
        // One undecodable event in the middle of a log must not make every
        // question in the vault unanswerable.
        let good = frame(
            &"d".repeat(32),
            ObservationKind::ExtractedAssertion,
            fields(
                AssertionKind::Presence,
                "stage",
                TypedValue::string("shipping"),
            ),
        );
        let mut bad = good.clone();
        bad.event_id = "e".repeat(32);
        bad.body = serde_json::json!({"not": "an observation"});
        let corpus = Corpus::from_frames(&[bad, good]);
        assert_eq!(corpus.len(), 1);
        assert!(corpus.get(&"d".repeat(32)).is_some());
    }

    #[test]
    fn snapshots_and_system_events_are_not_assertions() {
        let mut snapshot = frame(
            &"f".repeat(32),
            ObservationKind::ExtractedAssertion,
            fields(AssertionKind::Presence, "p", TypedValue::string("v")),
        );
        snapshot.body["observation_kind"] = serde_json::json!("source_snapshot");
        assert!(Corpus::from_frames(&[snapshot]).is_empty());
    }
}
