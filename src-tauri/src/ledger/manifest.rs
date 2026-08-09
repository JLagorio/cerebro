//! The projection manifest (M23.0 — the creation half). Format-1 entries
//! map vault-relative projection paths (`knowledge/…`) to the exact reducer
//! identity that produced their bytes: Belief, revision, revision event,
//! generating event, projection-state digest, and content hash.
//!
//! M23.2 adds the pending write protocol and the three-way F/M/R
//! classifier. Here the manifest is only ever CREATED — after migration
//! completes, and only when every knowledge file byte-matches its reducer
//! projection. A vault whose files disagree gets no manifest; the launch
//! reconciliation scan (M23.6) owns that state.
//!
//! `.cerebro/projection-manifest.json` travels with the vault and stays
//! under the `.cerebro/` blanket gitignore/self-heal.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::frame::Frame;
use super::project::project;
use super::reduce::{BeliefState, EpistemicState};
use super::schema;

/// The one manifest format this build reads and writes.
pub const MANIFEST_FORMAT: u64 = 1;

/// Vault-relative manifest location.
pub const MANIFEST_PATH: &str = ".cerebro/projection-manifest.json";

pub fn manifest_path(vault: &Path) -> PathBuf {
    vault.join(MANIFEST_PATH)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: u64,
    /// Vault-relative path (`knowledge/…`) → entry.
    pub entries: BTreeMap<String, ManifestEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteState {
    /// Target tuple stored; the projection file write may not have landed.
    Pending,
    /// File and entry agree; `previous_content_hash` is cleared.
    Complete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestEntry {
    pub belief_id: String,
    pub projected_revision: u64,
    /// The Belief revision event (`belief.created`/`belief.revised`) whose
    /// content these bytes render.
    pub belief_revision_event: String,
    /// The highest-seq event in the projection-state descriptor — advances
    /// on ANY projection-state transition, byte-identical ones included.
    pub generating_event: String,
    pub projection_state_digest: String,
    /// SHA-256 of the intended projected bytes.
    pub content_hash: String,
    pub write_state: WriteState,
    /// The prior file hash, held only while `write_state` is pending.
    pub previous_content_hash: Option<String>,
}

/// The canonical projection-state descriptor: every event the renderer's
/// output (or its identity) depends on. `generating_event` is the highest-
/// seq member — NOT merely the newest byte producer — so a review-state
/// change, relation remove, alias addition, or override clear advances
/// projection identity even when the resulting bytes equal an older
/// projection.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectionStateDescriptor {
    pub belief_revision_event: String,
    /// Attestation event IDs read by the renderer, seq order.
    pub review_event_ids: Vec<String>,
    /// Latest add/remove event per relation, sorted by relation_id.
    pub relation_transition_heads: Vec<RelationHead>,
    /// Live subject-alias event IDs sorted by normalized alias.
    pub alias_event_ids: Vec<String>,
    /// Active override event IDs in application order (none until M23.1).
    pub active_override_event_ids: Vec<String>,
    /// The latest override set/supersede/clear event, clear included.
    pub override_head_event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RelationHead {
    pub relation_id: String,
    pub event_id: String,
}

impl ProjectionStateDescriptor {
    /// SHA-256 of the canonical JSON serialization (fixed field order).
    pub fn digest(&self) -> Result<String, String> {
        let canonical = serde_json::to_string(self).map_err(|e| e.to_string())?;
        Ok(crate::ledger::sha256_hex(canonical.as_bytes()))
    }

    /// Every event the descriptor names, in serialization order.
    fn event_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = vec![&self.belief_revision_event];
        ids.extend(self.review_event_ids.iter().map(String::as_str));
        ids.extend(
            self.relation_transition_heads
                .iter()
                .map(|h| h.event_id.as_str()),
        );
        ids.extend(self.alias_event_ids.iter().map(String::as_str));
        ids.extend(self.active_override_event_ids.iter().map(String::as_str));
        if let Some(head) = &self.override_head_event_id {
            ids.push(head);
        }
        ids
    }

    /// The highest-seq event named by the descriptor — the entry's
    /// `generating_event`. Every named event must exist in the chain.
    pub fn generating_event(&self, seq_of: &BTreeMap<String, u64>) -> Result<String, String> {
        let mut best: Option<(u64, &str)> = None;
        for id in self.event_ids() {
            let seq = seq_of
                .get(id)
                .ok_or_else(|| format!("descriptor names {id}, which is not in the chain"))?;
            if best.is_none_or(|(s, _)| *seq > s) {
                best = Some((*seq, id));
            }
        }
        best.map(|(_, id)| id.to_string())
            .ok_or_else(|| "empty descriptor".to_string())
    }
}

/// event_id → seq over the committed chain, for generating-event selection.
pub fn seq_index(frames: &[Frame]) -> BTreeMap<String, u64> {
    frames.iter().map(|f| (f.event_id.clone(), f.seq)).collect()
}

/// Build the descriptor for one Belief from reduced state. Attestations are
/// scanned from the committed frames (the reducer keeps only the latest
/// pointer): an attestation counts only when it APPLIED — not refused as an
/// anomaly, and, if batched, its batch committed.
pub fn descriptor(
    state: &EpistemicState,
    frames: &[Frame],
    belief: &BeliefState,
) -> ProjectionStateDescriptor {
    let refused: std::collections::BTreeSet<&str> = state
        .anomalies
        .iter()
        .map(|a| a.event_id.as_str())
        .collect();
    let committed_members: std::collections::BTreeSet<&str> = state
        .batches
        .iter()
        .filter(|b| b.state == "committed")
        .flat_map(|b| b.members.iter().map(|(id, _)| id.as_str()))
        .collect();
    let mut review_event_ids = Vec::new();
    for frame in frames {
        if frame.kind != schema::KIND_BELIEF_ATTESTED {
            continue;
        }
        if frame.body.get("belief_id").and_then(|v| v.as_str()) != Some(belief.belief_id.as_str()) {
            continue;
        }
        if refused.contains(frame.event_id.as_str()) {
            continue;
        }
        let batched = frame.body.get("batch_id").is_some_and(|v| !v.is_null());
        if batched && !committed_members.contains(frame.event_id.as_str()) {
            continue;
        }
        review_event_ids.push(frame.event_id.clone());
    }

    // BTreeMap iteration: relations sorted by relation_id, aliases by
    // normalized alias — exactly the descriptor's required orders.
    let relation_transition_heads = state
        .relations
        .values()
        .filter(|r| r.from == belief.belief_id)
        .map(|r| RelationHead {
            relation_id: r.relation_id.clone(),
            event_id: r.last_event_id.clone(),
        })
        .collect();
    let alias_event_ids = state
        .alias_registry
        .values()
        .filter(|a| a.entity_id == belief.entity_id)
        .map(|a| a.event_id.clone())
        .collect();

    ProjectionStateDescriptor {
        belief_revision_event: belief.current().event_id.clone(),
        review_event_ids,
        relation_transition_heads,
        alias_event_ids,
        active_override_event_ids: Vec::new(),
        override_head_event_id: None,
    }
}

/// Load the manifest; `Ok(None)` when none exists. An unreadable or
/// alien-format manifest is an error, never silently regenerated here.
pub fn load(vault: &Path) -> Result<Option<Manifest>, String> {
    let path = manifest_path(vault);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let manifest: Manifest =
        serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(format!(
            "{}: unsupported manifest format {}",
            path.display(),
            manifest.format
        ));
    }
    Ok(Some(manifest))
}

/// Atomically persist the manifest: temp write, fsync, rename, dir fsync.
pub fn save(vault: &Path, manifest: &Manifest) -> Result<(), String> {
    let path = manifest_path(vault);
    let dir = path.parent().ok_or("manifest path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(bytes.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    super::fsync_dir(dir)
}

/// Build the initial complete manifest after migration: one entry per
/// `knowledge/*.md` file, but ONLY when every file byte-matches its reducer
/// projection. `Ok(None)` means the files and the reducer disagree — the
/// manifest must not exist until reconciliation explains the difference.
pub fn build_initial(
    vault: &Path,
    store_id: &str,
    frames: &[Frame],
    state: &EpistemicState,
) -> Result<Option<Manifest>, String> {
    let knowledge = vault.join("knowledge");
    let mut entries = BTreeMap::new();
    let seq_of = seq_index(frames);
    if knowledge.exists() {
        for entry in walkdir::WalkDir::new(&knowledge).sort_by_file_name() {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|e| e.to_str()) != Some("md")
            {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&knowledge)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("non-UTF-8 knowledge path")?
                .replace('\\', "/");
            let Some(belief) = state
                .beliefs
                .get(&schema::migrate_id(store_id, "belief", &rel))
            else {
                return Ok(None); // a file the ledger cannot explain
            };
            let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
            let current = belief.current();
            let projected = project(&current.content, &current.fields);
            if projected.as_bytes() != bytes.as_slice() {
                return Ok(None); // bytes disagree — reconciliation's problem
            }
            let descriptor = descriptor(state, frames, belief);
            entries.insert(
                format!("knowledge/{rel}"),
                ManifestEntry {
                    belief_id: belief.belief_id.clone(),
                    projected_revision: current.revision,
                    belief_revision_event: current.event_id.clone(),
                    generating_event: descriptor.generating_event(&seq_of)?,
                    projection_state_digest: descriptor.digest()?,
                    content_hash: crate::ledger::sha256_hex(&bytes),
                    write_state: WriteState::Complete,
                    previous_content_hash: None,
                },
            );
        }
    }
    Ok(Some(Manifest {
        format: MANIFEST_FORMAT,
        entries,
    }))
}

#[cfg(test)]
mod tests {
    use super::super::migrate::migrate_vault;
    use super::super::migrate::tests::{corpus_copy, WRITER};
    use super::super::reduce::reduce;
    use super::super::writer::LedgerWriter;
    use super::super::{ledger_dir, read_ledger};
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn the_manifest_round_trips_atomically_and_refuses_alien_shapes() {
        let vault = testutil::temp_vault("manifest-roundtrip");
        assert_eq!(load(&vault).unwrap(), None, "no manifest yet");
        let manifest = Manifest {
            format: MANIFEST_FORMAT,
            entries: BTreeMap::from([(
                "knowledge/a.md".to_string(),
                ManifestEntry {
                    belief_id: "b".repeat(32),
                    projected_revision: 1,
                    belief_revision_event: "e".repeat(32),
                    generating_event: "e".repeat(32),
                    projection_state_digest: "0".repeat(64),
                    content_hash: "1".repeat(64),
                    write_state: WriteState::Complete,
                    previous_content_hash: None,
                },
            )]),
        };
        save(&vault, &manifest).unwrap();
        assert_eq!(load(&vault).unwrap(), Some(manifest.clone()));
        // No temp debris survives the atomic protocol.
        assert!(!manifest_path(&vault).with_extension("json.tmp").exists());

        // An unknown field is refused, never silently dropped.
        let mut raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(manifest_path(&vault)).unwrap()).unwrap();
        raw["entries"]["knowledge/a.md"]["mystery"] = serde_json::json!(true);
        std::fs::write(manifest_path(&vault), raw.to_string()).unwrap();
        assert!(load(&vault).is_err());

        // A future format is refused, never guessed at.
        let mut future = manifest;
        future.format = 2;
        save(&vault, &future).unwrap();
        assert!(load(&vault).unwrap_err().contains("unsupported"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_descriptor_head_outranks_the_revision_event_when_review_advanced() {
        let vault = corpus_copy("manifest-descriptor");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        let seq_of = seq_index(&read.frames);

        // A verified concept: its attestation was appended AFTER creation,
        // so the generating event is the attestation, not the revision.
        let verified = state
            .beliefs
            .values()
            .find(|b| b.attested.is_some())
            .expect("the corpus has verified concepts");
        let described = descriptor(&state, &read.frames, verified);
        assert!(!described.review_event_ids.is_empty());
        let head = described.generating_event(&seq_of).unwrap();
        assert_eq!(head, *described.review_event_ids.last().unwrap());
        assert!(seq_of[&head] > seq_of[&described.belief_revision_event]);
        // Digest is deterministic and moves when review state moves.
        let again = descriptor(&state, &read.frames, verified);
        assert_eq!(described.digest().unwrap(), again.digest().unwrap());
        let mut without_review = described.clone();
        without_review.review_event_ids.clear();
        assert_ne!(
            described.digest().unwrap(),
            without_review.digest().unwrap()
        );

        // An unverified concept's head IS its revision event.
        let unverified = state
            .beliefs
            .values()
            .find(|b| {
                b.attested.is_none() && {
                    let d = descriptor(&state, &read.frames, b);
                    d.relation_transition_heads.is_empty() && d.alias_event_ids.is_empty()
                }
            })
            .expect("the corpus has plain concepts");
        let plain = descriptor(&state, &read.frames, unverified);
        assert_eq!(
            plain.generating_event(&seq_of).unwrap(),
            plain.belief_revision_event
        );
        // A descriptor naming an event outside the chain is an error.
        let mut alien = plain;
        alien.review_event_ids.push("f".repeat(32));
        assert!(alien.generating_event(&seq_of).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }
}
