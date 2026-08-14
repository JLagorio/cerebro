//! The normalized snapshot — what "changed" is allowed to mean (M25.1).
//!
//! The scheduler stores a whole normalized snapshot per item, not just a
//! hash, and this module defines it. Two hashes can only ever say
//! "different"; a restart that cannot say WHICH FIELD moved cannot reproduce
//! its own materiality verdict, and would have to escalate every item it
//! could not explain.
//!
//! **What is deliberately NOT in a snapshot: time.** `modified_at` and
//! `created_at` are absent by construction. The pre-M25 scheduler keyed
//! "behind" on mtime (`src/engine/okf.ts`), which is why a `git checkout`
//! floods the queue: checkout rewrites every mtime and changes no content.
//! A normalizer that included a timestamp would reintroduce that bug one
//! layer down, where it would be much harder to see. `snippet` and
//! `parse_error` are out for the same family of reasons — one is derived
//! from the body, the other is an ingestion signal rather than content.
//!
//! **Canonical bytes.** The snapshot serializes as JSON with sorted keys, so
//! two runs over the same file produce byte-identical output and the stored
//! `normalized_snapshot_hash` is comparable across processes and machines.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ledger::sha256_hex;
use crate::vault::entry::Entry;

/// Bumped whenever the fields, their normalization, or the canonical
/// serialization change. A stored snapshot from an older normalizer is not
/// comparable to a new one — the version is what lets the scheduler notice
/// instead of silently diffing two different languages.
pub const NORMALIZER_VERSION: &str = "vault-entry-v1";

/// One item's content, in the shape the prefilter diffs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub normalizer_version: String,
    /// Sorted field path → value. `title`, `type`, every frontmatter
    /// property, and the two link shapes the scanner derives.
    pub fields: BTreeMap<String, serde_json::Value>,
}

impl Snapshot {
    /// Canonical JSON — serde, declaration order, sorted maps. The same
    /// definition the ledger's digests use.
    pub fn canonical(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    /// `sha256(canonical)` — the receipt's `normalized_snapshot_hash`.
    pub fn hash(&self) -> Result<String, String> {
        Ok(sha256_hex(self.canonical()?.as_bytes()))
    }

    /// Field paths whose values differ, sorted. A field present on one side
    /// only counts as changed; that is an addition or a removal, and both are
    /// world-state news.
    pub fn changed_fields(&self, other: &Snapshot) -> Vec<String> {
        let mut changed: Vec<String> = self
            .fields
            .keys()
            .chain(other.fields.keys())
            .filter(|key| self.fields.get(*key) != other.fields.get(*key))
            .cloned()
            .collect();
        changed.sort();
        changed.dedup();
        changed
    }
}

/// The normalized snapshot of a scanned entry.
///
/// `relationships` arrive from the scanner already bracket-stripped and live
/// beside `properties` rather than inside it (the M22-era scanner contract),
/// so both are read explicitly here — a normalizer that only walked
/// `properties` would silently treat every wikilink field as absent.
pub fn snapshot(entry: &Entry) -> Snapshot {
    let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    fields.insert("title".into(), serde_json::json!(entry.title));
    fields.insert("type".into(), serde_json::json!(entry.entry_type));
    for (key, value) in &entry.properties {
        fields.insert(format!("properties.{key}"), value.clone());
    }
    for (key, value) in &entry.relationships {
        fields.insert(format!("relationships.{key}"), serde_json::json!(value));
    }
    fields.insert(
        "outgoing_links".into(),
        serde_json::json!(entry.outgoing_links),
    );
    Snapshot {
        normalizer_version: NORMALIZER_VERSION.to_string(),
        fields,
    }
}

/// The artifact hash: SHA-256 of the file's bytes exactly as they are on
/// disk. Distinct from the snapshot hash on purpose — identical bytes under a
/// new normalizer are still the same artifact, and an artifact whose bytes
/// changed without changing any normalized field is exactly the case the
/// prefilter must be able to close as `non_material_change`.
pub fn artifact_hash(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(title: &str) -> Entry {
        let mut e = Entry::empty_for_test("records/a.md");
        e.title = title.to_string();
        e
    }

    #[test]
    fn a_touched_file_is_not_a_changed_file() {
        // THE bug this milestone exists to kill: `git checkout` rewrites every
        // mtime and changes no content. If a timestamp were ever in here, the
        // whole vault would look material after every branch switch.
        let mut before = entry("Alpha");
        before.modified_at = "2026-08-01T00:00:00Z".into();
        let mut after = before.clone();
        after.modified_at = "2026-08-09T23:59:59Z".into();
        after.created_at = "2026-08-09T23:59:59Z".into();

        let a = snapshot(&before);
        let b = snapshot(&after);
        assert_eq!(a, b);
        assert_eq!(a.hash().unwrap(), b.hash().unwrap());
        assert!(a.changed_fields(&b).is_empty());
    }

    #[test]
    fn a_changed_field_is_named_not_merely_counted() {
        let before = snapshot(&entry("Alpha"));
        let after = snapshot(&entry("Beta"));
        assert_eq!(after.changed_fields(&before), vec!["title".to_string()]);
        assert_ne!(before.hash().unwrap(), after.hash().unwrap());
    }

    #[test]
    fn wikilink_fields_are_read_from_relationships_not_properties() {
        // The scanner delivers wikilink fields bracket-stripped in
        // `relationships`; a normalizer that only walked `properties` would
        // call every relation edit a no-change.
        let mut before = entry("Alpha");
        before
            .relationships
            .insert("owner".into(), vec!["Ada".into()]);
        let mut after = before.clone();
        after
            .relationships
            .insert("owner".into(), vec!["Grace".into()]);
        assert_eq!(
            snapshot(&after).changed_fields(&snapshot(&before)),
            vec!["relationships.owner".to_string()]
        );
    }

    #[test]
    fn an_added_field_and_a_removed_field_both_count_as_changed() {
        let before = snapshot(&entry("Alpha"));
        let mut with_status = entry("Alpha");
        with_status
            .properties
            .insert("status".into(), serde_json::json!("shipped"));
        let after = snapshot(&with_status);
        assert_eq!(
            after.changed_fields(&before),
            vec!["properties.status".to_string()]
        );
        assert_eq!(
            before.changed_fields(&after),
            vec!["properties.status".to_string()],
            "removal is as material as addition"
        );
    }

    #[test]
    fn canonical_bytes_are_stable_across_calls_and_round_trip() {
        let snap = snapshot(&entry("Alpha"));
        let bytes = snap.canonical().unwrap();
        assert_eq!(bytes, snap.canonical().unwrap());
        let parsed: Snapshot = serde_json::from_str(&bytes).unwrap();
        assert_eq!(parsed, snap);
        assert_eq!(parsed.canonical().unwrap(), bytes);
    }

    #[test]
    fn the_artifact_hash_is_the_bytes_not_the_fields() {
        // Identical normalized fields, different bytes: the artifact moved
        // and the meaning did not, which is the `non_material_change` case.
        let a = artifact_hash(b"---\ntitle: Alpha\n---\nbody\n");
        let b = artifact_hash(b"---\ntitle: Alpha\n---\nbody\n\n");
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }
}
