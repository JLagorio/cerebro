//! `projection.overridden` (M23.1) — editorial presentation state.
//!
//! An override is CANONICAL PROJECTION STATE, never evidence: it changes
//! what `project()` renders, but it can never enter Observation lineage,
//! Belief basis, support, or independence — the reducer has no place to put
//! it, and the evidence validators refuse the reference.

use serde::{Deserialize, Serialize};

use super::value::TypedValue;
use super::{is_id128, is_sha256, schema_body};

/// Frontmatter fields declared presentation-only — the ONLY legal override
/// targets besides `/body`. Everything else (generated/verified provenance,
/// epistemic frontmatter, relation pointers) is an illegal override target.
pub const PRESENTATION_ONLY_FIELDS: [&str; 2] = ["title", "tags"];

/// A projection-override pointer: `/body`, or a declared presentation-only
/// field (optionally a subpath inside it).
pub fn validate_override_pointer(path: &str) -> Result<(), String> {
    super::value::validate_field_path(path)?;
    if path == "/body" {
        return Ok(());
    }
    let field = path
        .strip_prefix("/fields/")
        .expect("validate_field_path pinned the shape");
    let head = field.split('/').next().unwrap_or(field);
    if PRESENTATION_ONLY_FIELDS.contains(&head) {
        Ok(())
    } else {
        Err(format!(
            "override pointer {path:?} targets an epistemic or provenance field — only /body and \
             declared presentation-only fields ({}) may be overridden",
            PRESENTATION_ONLY_FIELDS.join(", ")
        ))
    }
}

/// Which channel produced the override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverrideOrigin {
    InApp,
    OutOfBand,
    ReconciliationAdoption,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverridePatchOp {
    pub field_path: String,
    pub before: TypedValue,
    pub after: TypedValue,
}

/// The tagged set-or-clear change. A set may supersede prior overlays; a
/// clear names the active overrides it retires and why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum OverrideChange {
    Set {
        patch: Vec<OverridePatchOp>,
        supersedes_override_event_ids: Vec<String>,
    },
    Clear {
        override_event_ids: Vec<String>,
        reason: String,
    },
}

schema_body! {
    /// Editorial projection override. Pins the Belief revision AND the full
    /// projection-state head it was computed against (so a byte-identical
    /// attestation/relation/override transition still invalidates a stale
    /// edit), plus the exact before/after projection hashes the reducer
    /// must reproduce.
    pub struct ProjectionOverridden {
        pub belief_id: String,
        pub path: String,
        pub base_belief_revision: u64,
        pub base_belief_revision_event: String,
        pub base_generating_event: String,
        pub before_projection_hash: String,
        pub after_projection_hash: String,
        pub origin: OverrideOrigin,
        pub change: OverrideChange,
    }
}

/// A knowledge-relative projection path: `systems/foo.md`, never absolute,
/// never escaping, always markdown.
pub fn validate_projection_path(path: &str) -> Result<(), String> {
    if path.is_empty() || !path.ends_with(".md") {
        return Err(format!("projection path {path:?} must be a .md file"));
    }
    if path.starts_with('/') || path.contains('\\') {
        return Err(format!(
            "projection path {path:?} must be knowledge-relative with forward slashes"
        ));
    }
    if path.split('/').any(|seg| seg.is_empty() || seg == "..") {
        return Err(format!(
            "projection path {path:?} must not escape or double-slash"
        ));
    }
    Ok(())
}

impl ProjectionOverridden {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.belief_id) {
            return Err("belief_id is not a stable 128-bit hex id".into());
        }
        validate_projection_path(&self.path)?;
        if self.base_belief_revision == 0 {
            return Err("base_belief_revision starts at 1".into());
        }
        if !is_id128(&self.base_belief_revision_event) {
            return Err("base_belief_revision_event is not an event id".into());
        }
        if !is_id128(&self.base_generating_event) {
            return Err("base_generating_event is not an event id".into());
        }
        if !is_sha256(&self.before_projection_hash) || !is_sha256(&self.after_projection_hash) {
            return Err("projection hashes must be SHA-256 hex".into());
        }
        match &self.change {
            OverrideChange::Set {
                patch,
                supersedes_override_event_ids,
            } => {
                if patch.is_empty() {
                    return Err("an override set requires a non-empty patch".into());
                }
                let mut seen = std::collections::BTreeSet::new();
                for op in patch {
                    validate_override_pointer(&op.field_path)?;
                    if !seen.insert(op.field_path.as_str()) {
                        return Err(format!("duplicate override pointer {}", op.field_path));
                    }
                    op.before.validate()?;
                    op.after.validate()?;
                }
                let mut ids = std::collections::BTreeSet::new();
                for id in supersedes_override_event_ids {
                    if !is_id128(id) {
                        return Err("superseded override ref is not an event id".into());
                    }
                    if !ids.insert(id.as_str()) {
                        return Err(format!("duplicate superseded override {id}"));
                    }
                }
            }
            OverrideChange::Clear {
                override_event_ids,
                reason,
            } => {
                if override_event_ids.is_empty() {
                    return Err("an override clear must name the overrides it retires".into());
                }
                let mut ids = std::collections::BTreeSet::new();
                for id in override_event_ids {
                    if !is_id128(id) {
                        return Err("cleared override ref is not an event id".into());
                    }
                    if !ids.insert(id.as_str()) {
                        return Err(format!("duplicate cleared override {id}"));
                    }
                }
                if reason.is_empty() {
                    return Err("an override clear requires a non-empty reason".into());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::tests::{common, ID_A, ID_B};
    use super::*;

    pub(crate) fn set_body() -> ProjectionOverridden {
        let (schema, actor) = common("human:josef");
        ProjectionOverridden {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: ID_A.into(),
            path: "concepts/acme.md".into(),
            base_belief_revision: 1,
            base_belief_revision_event: ID_B.into(),
            base_generating_event: ID_B.into(),
            before_projection_hash: crate::ledger::sha256_hex(b"before"),
            after_projection_hash: crate::ledger::sha256_hex(b"after"),
            origin: OverrideOrigin::InApp,
            change: OverrideChange::Set {
                patch: vec![OverridePatchOp {
                    field_path: "/body".into(),
                    before: TypedValue::string("\n# Acme\n\nActive vendor.\n"),
                    after: TypedValue::string("\n# Acme\n\nAn active vendor.\n"),
                }],
                supersedes_override_event_ids: vec![],
            },
        }
    }

    #[test]
    fn override_pointers_are_body_or_presentation_only() {
        validate_override_pointer("/body").unwrap();
        validate_override_pointer("/fields/title").unwrap();
        validate_override_pointer("/fields/tags").unwrap();
        validate_override_pointer("/fields/tags/0").unwrap();
        for illegal in [
            "/fields/generated",
            "/fields/verified",
            "/fields/about",
            "/fields/sources",
            "/fields/supersedes",
            "/fields/status",
            "/other",
        ] {
            assert!(
                validate_override_pointer(illegal).is_err(),
                "{illegal} must be refused"
            );
        }
    }

    #[test]
    fn projection_paths_are_relative_markdown_only() {
        validate_projection_path("concepts/acme.md").unwrap();
        validate_projection_path("acme.md").unwrap();
        for bad in [
            "",
            "/abs.md",
            "no-extension",
            "a//b.md",
            "../escape.md",
            "a/../b.md",
            "back\\slash.md",
        ] {
            assert!(validate_projection_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn set_and_clear_shapes_are_pinned() {
        let event = set_body();
        event.validate().unwrap();

        let mut empty_patch = event.clone();
        empty_patch.change = OverrideChange::Set {
            patch: vec![],
            supersedes_override_event_ids: vec![],
        };
        assert!(empty_patch.validate().is_err());

        let mut illegal = event.clone();
        illegal.change = OverrideChange::Set {
            patch: vec![OverridePatchOp {
                field_path: "/fields/verified".into(),
                before: TypedValue::Missing,
                after: TypedValue::string("forged"),
            }],
            supersedes_override_event_ids: vec![],
        };
        assert!(illegal
            .validate()
            .unwrap_err()
            .contains("presentation-only"));

        let mut clear = event.clone();
        clear.change = OverrideChange::Clear {
            override_event_ids: vec![ID_B.into()],
            reason: "maintenance retired the tweak".into(),
        };
        clear.validate().unwrap();
        clear.change = OverrideChange::Clear {
            override_event_ids: vec![],
            reason: "x".into(),
        };
        assert!(clear.validate().is_err(), "a clear must name its targets");

        let mut bad_hash = event;
        bad_hash.after_projection_hash = "short".into();
        assert!(bad_hash.validate().is_err());
    }
}
