//! Tagged subjects and lineage edges (M22.1).
//!
//! "Unresolved is data": a subject is explicitly `resolved`, `unresolved`,
//! or `none` — no entity or assertion is ever invented to satisfy serde.

use serde::{Deserialize, Serialize};

use super::is_id128;

/// Exactly one of the three subject states. Subject `aliases` preserve
/// source spelling and are immutable resolution HINTS — they never register
/// canonical aliases (only `entity.alias_added` mutates the registry).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "resolution", rename_all = "snake_case")]
pub enum SubjectRef {
    Resolved {
        entity_id: String,
        aliases: Vec<String>,
    },
    Unresolved {
        raw_ref: String,
        aliases: Vec<String>,
    },
    None,
}

impl SubjectRef {
    pub fn validate(&self) -> Result<(), String> {
        let aliases = match self {
            SubjectRef::Resolved { entity_id, aliases } => {
                if !is_id128(entity_id) {
                    return Err(format!(
                        "subject entity_id {entity_id:?} is not a 128-bit hex id"
                    ));
                }
                aliases
            }
            SubjectRef::Unresolved { raw_ref, aliases } => {
                if raw_ref.is_empty() {
                    return Err("unresolved subject raw_ref must be non-empty".to_string());
                }
                aliases
            }
            SubjectRef::None => return Ok(()),
        };
        if aliases.iter().any(String::is_empty) {
            return Err("subject aliases must be non-empty source spellings".to_string());
        }
        Ok(())
    }

    pub fn is_none(&self) -> bool {
        matches!(self, SubjectRef::None)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineageKind {
    ReportedBy,
    DerivedFrom,
    CopiedFrom,
    SummarizedFrom,
}

/// One transformation-ancestry edge. Parents must be Observation events;
/// canonical order (ascending committed parent seq, same-batch parents by
/// member ordinal) and parent-kind checks are reduce-time — this layer owns
/// shape, id format, and uniqueness.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LineageEdge {
    pub edge: LineageKind,
    pub parent_observation_event_id: String,
}

/// Structural lineage rules: well-formed unique parent ids.
pub fn validate_lineage(lineage: &[LineageEdge]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for edge in lineage {
        if !is_id128(&edge.parent_observation_event_id) {
            return Err(format!(
                "lineage parent {:?} is not a 128-bit hex event id",
                edge.parent_observation_event_id
            ));
        }
        if !seen.insert(edge.parent_observation_event_id.as_str()) {
            return Err(format!(
                "duplicate lineage parent {}",
                edge.parent_observation_event_id
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn the_three_subject_states_round_trip_canonically() {
        let cases = [
            (
                SubjectRef::Resolved {
                    entity_id: ID.into(),
                    aliases: vec!["Acme".into()],
                },
                format!(r#"{{"resolution":"resolved","entity_id":"{ID}","aliases":["Acme"]}}"#),
            ),
            (
                SubjectRef::Unresolved {
                    raw_ref: "Acme Corp".into(),
                    aliases: vec![],
                },
                r#"{"resolution":"unresolved","raw_ref":"Acme Corp","aliases":[]}"#.to_string(),
            ),
            (SubjectRef::None, r#"{"resolution":"none"}"#.to_string()),
        ];
        for (subject, want) in cases {
            let line = serde_json::to_string(&subject).unwrap();
            assert_eq!(line, want);
            let back: SubjectRef = serde_json::from_str(&line).unwrap();
            assert_eq!(back, subject);
            subject.validate().unwrap();
        }
    }

    #[test]
    fn malformed_subjects_are_refused() {
        assert!(SubjectRef::Resolved {
            entity_id: "SHOUTING".into(),
            aliases: vec![]
        }
        .validate()
        .is_err());
        assert!(SubjectRef::Unresolved {
            raw_ref: String::new(),
            aliases: vec![]
        }
        .validate()
        .is_err());
        assert!(SubjectRef::Resolved {
            entity_id: ID.into(),
            aliases: vec![String::new()]
        }
        .validate()
        .is_err());
    }

    #[test]
    fn lineage_refuses_bad_ids_and_duplicates() {
        let edge = |id: &str| LineageEdge {
            edge: LineageKind::DerivedFrom,
            parent_observation_event_id: id.into(),
        };
        validate_lineage(&[edge(ID)]).unwrap();
        assert!(validate_lineage(&[edge("nope")]).is_err());
        assert!(validate_lineage(&[edge(ID), edge(ID)]).is_err());
        // Different edge kinds do not un-duplicate the same parent.
        let mut second = edge(ID);
        second.edge = LineageKind::CopiedFrom;
        assert!(validate_lineage(&[edge(ID), second]).is_err());
    }

    #[test]
    fn a_lineage_edge_kind_outside_the_enum_is_refused() {
        let raw = format!(r#"{{"edge":"inspired_by","parent_observation_event_id":"{ID}"}}"#);
        assert!(serde_json::from_str::<LineageEdge>(&raw).is_err());
    }
}
