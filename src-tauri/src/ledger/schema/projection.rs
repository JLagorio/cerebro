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
/// never escaping, always markdown, and spelled one way — no `.` or empty
/// segment, so `./x.md` and `a//b.md` cannot claim `x.md`'s and `a/b.md`'s
/// file under a second key. The leaf must name a file: `.md` alone is a
/// dotfile with no extension, which the projection writer refuses. A
/// dot-folder or a dotfile with a stem (`.archive/x.md`, `.hidden.md`) stays
/// legal, because the migration and the move adoption record what a person
/// filed there.
///
/// The schema runs this on every path a projection or reconciliation event
/// names and on the claim a created Belief makes (`validate_projection_claim`),
/// so the writer refuses a bad path before a byte of its batch is written. A
/// claim is held to more (`validate_claimable_path`).
pub fn validate_projection_path(path: &str) -> Result<(), String> {
    if path.is_empty() || !path.ends_with(".md") {
        return Err(format!("projection path {path:?} must be a .md file"));
    }
    if path.starts_with('/') || path.contains('\\') {
        return Err(format!(
            "projection path {path:?} must be knowledge-relative with forward slashes"
        ));
    }
    if path
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(format!(
            "projection path {path:?} must not escape, double-slash or carry a '.' segment"
        ));
    }
    if path.rsplit('/').next() == Some(".md") {
        return Err(format!(
            "projection path {path:?} names no file — '.md' alone is a dotfile with no extension"
        ));
    }
    Ok(())
}

/// The most bytes one path segment holds: NAME_MAX on APFS and ext4.
pub const MAX_SEGMENT_BYTES: usize = 255;

/// What the projection writer appends to a leaf for its temp file:
/// `manifest::write_projection_as` writes `<leaf>.cerebro-tmp`, then renames
/// it over the leaf.
const WRITER_TEMP_SUFFIX: &str = ".cerebro-tmp";

/// The longest leaf a claim may name, 243 bytes: the writer's temp file
/// must fit in a segment too. Pinned against the writer itself by
/// `reduce::tests::the_longest_claimable_leaf_is_one_the_projection_writer_can_write`.
pub const MAX_CLAIM_LEAF_BYTES: usize = MAX_SEGMENT_BYTES - WRITER_TEMP_SUFFIX.len();

/// A path a created Belief may claim: a projection path the projection writer
/// can create (M53.29). On top of the shape rule it carries no control
/// character (U+0000–U+001F, U+007F–U+009F; a NUL is a name no file call
/// takes, and the rest break every line a path is written into — the
/// knowledge log, a git listing), no folder name over `MAX_SEGMENT_BYTES` and
/// no leaf over `MAX_CLAIM_LEAF_BYTES`. Bytes, not characters: 82 CJK
/// characters are 246 bytes.
///
/// Only a claim — a path entering the ledger — is held to this, a migrated
/// file's included. The other paths an event names (a move's target, a
/// divergence's sample, a resolution's affected paths) are files already on
/// disk or claims already made, and refusing their event would stop the
/// launch scan itself (`reconcile::adopt_moves` appends with `?`). Two claims
/// that cannot both be files, one inside the other, are the reducer's to
/// refuse: only it sees the other claim.
pub fn validate_claimable_path(path: &str) -> Result<(), String> {
    validate_projection_path(path)?;
    if let Some(control) = path.chars().find(|c| c.is_control()) {
        return Err(format!(
            "projection path {path:?} carries the control character U+{:04X}",
            u32::from(control)
        ));
    }
    let mut segments = path.split('/').rev();
    let leaf = segments.next().unwrap_or(path);
    if leaf.len() > MAX_CLAIM_LEAF_BYTES {
        return Err(format!(
            "projection path {path:?} names a {}-byte file — the projection writer's temp file \
             needs it at {MAX_CLAIM_LEAF_BYTES} bytes or fewer",
            leaf.len()
        ));
    }
    if let Some(folder) = segments.find(|segment| segment.len() > MAX_SEGMENT_BYTES) {
        return Err(format!(
            "projection path {path:?} has a {}-byte folder name — a file system holds \
             {MAX_SEGMENT_BYTES}",
            folder.len()
        ));
    }
    Ok(())
}

/// The projection path a created Belief's subject claims: its first `.md`
/// alias, or none. The reducer files the Belief under this path, one Belief
/// per path, and the projection writes `knowledge/<claim>`.
pub fn projection_claim(aliases: &[String]) -> Option<&str> {
    aliases
        .iter()
        .map(String::as_str)
        .find(|alias| alias.ends_with(".md"))
}

/// A claim, when the aliases make one, must be claimable (M53.29).
/// Unchecked, a governed apply committed a claim like `../x.md`, and the
/// projection step refused it only after the set was durable; every
/// reconciliation exit rewrites every projection, so each exit failed from
/// then on. Only the claim is judged: a later `.md` alias claims nothing and
/// is a resolution hint like any other.
pub fn validate_projection_claim(aliases: &[String]) -> Result<(), String> {
    match projection_claim(aliases) {
        Some(claim) => validate_claimable_path(claim),
        None => Ok(()),
    }
}

schema_body! {
    /// A projection's FILE moved (M49.5, K29): the same bytes, at a new
    /// knowledge-relative path — a rename in Finder, a folder tidied in
    /// Obsidian. Before this event no transition could change a Belief's
    /// path, so a moved concept read as one concept deleted and one file
    /// nobody recorded, and neither half could be kept.
    ///
    /// `projection_hash` is the projection the move adopts; the reducer
    /// refuses unless the Belief's current projection hashes to it, so a
    /// move can never carry a content change in with it.
    pub struct ProjectionMoved {
        pub belief_id: String,
        pub from_path: String,
        pub to_path: String,
        pub projection_hash: String,
    }
}

impl ProjectionMoved {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.belief_id) {
            return Err("belief_id is not a stable 128-bit hex id".into());
        }
        validate_projection_path(&self.from_path)?;
        validate_projection_path(&self.to_path)?;
        if self.from_path == self.to_path {
            return Err("a move names two different paths".into());
        }
        if !is_sha256(&self.projection_hash) {
            return Err("projection_hash must be SHA-256 hex".into());
        }
        Ok(())
    }
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
        // What a person files under a dot-folder, or as a dotfile with a
        // stem, the migration and the move adoption record as written.
        validate_projection_path(".archive/x.md").unwrap();
        validate_projection_path(".hidden.md").unwrap();
        for bad in [
            "",
            "/abs.md",
            "no-extension",
            "a//b.md",
            "../escape.md",
            "a/../b.md",
            "back\\slash.md",
            // One file, two keys.
            "./x.md",
            "a/./b.md",
            // A leaf that names no file.
            ".md",
            "a/.md",
        ] {
            assert!(validate_projection_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_claimable_path_is_one_the_projection_writer_can_create() {
        let leaf = |bytes: usize| format!("concepts/{}.md", "a".repeat(bytes - 3));
        let folder = |bytes: usize| format!("{}/acme.md", "d".repeat(bytes));
        assert_eq!(MAX_CLAIM_LEAF_BYTES, 243);
        for good in [
            "concepts/acme.md".to_string(),
            ".archive/x.md".to_string(),
            leaf(MAX_CLAIM_LEAF_BYTES),
            folder(MAX_SEGMENT_BYTES),
            // U+00A0 is the first code point past the C1 controls.
            "concepts/a\u{a0}b.md".to_string(),
            // 80 CJK characters and the extension: 243 bytes.
            format!("concepts/{}.md", "\u{6982}".repeat(80)),
        ] {
            validate_claimable_path(&good).unwrap();
        }
        for bad in [
            // A NUL is a name no file call takes; the rest of C0, DEL and C1
            // break the line a path is written into.
            "concepts/a\0b.md".to_string(),
            "concepts/a\u{1f}b.md".to_string(),
            "concepts/a\nb.md".to_string(),
            "concepts/a\u{7f}b.md".to_string(),
            "concepts/a\u{80}b.md".to_string(),
            "concepts/a\u{9f}b.md".to_string(),
            // The writer's `<leaf>.cerebro-tmp` would pass NAME_MAX.
            leaf(MAX_CLAIM_LEAF_BYTES + 1),
            // 82 CJK characters and the extension: 85 characters, 249 bytes.
            format!("concepts/{}.md", "\u{6982}".repeat(82)),
            folder(MAX_SEGMENT_BYTES + 1),
            // Still the shape rule first.
            "../escape.md".to_string(),
        ] {
            let error = validate_claimable_path(&bad).unwrap_err();
            assert!(error.contains("projection path"), "{bad:?}: {error}");
            assert!(
                !error.contains('\0') && !error.contains('\n'),
                "the refusal escapes what it quotes: {error:?}"
            );
        }
        // Only a claim is held to the writer's limits: a file a person
        // already filed keeps the shape rule alone, so the event that names
        // it — a move, a divergence sample — can still be appended.
        validate_projection_path("concepts/a\u{7f}b.md").unwrap();
        validate_projection_path(&leaf(MAX_SEGMENT_BYTES)).unwrap();
    }

    #[test]
    fn the_claim_is_the_first_markdown_alias_and_only_it_is_judged() {
        let aliases = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(projection_claim(&aliases(&["Acme Corp"])), None);
        assert_eq!(
            projection_claim(&aliases(&["Acme Corp", "concepts/acme.md", "other.md"])),
            Some("concepts/acme.md")
        );
        validate_projection_claim(&aliases(&[])).unwrap();
        validate_projection_claim(&aliases(&["../not/a/claim"])).unwrap();
        validate_projection_claim(&aliases(&["concepts/acme.md", "../escape.md"])).unwrap();
        assert!(
            validate_projection_claim(&aliases(&["../escape.md", "concepts/acme.md"])).is_err()
        );
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
