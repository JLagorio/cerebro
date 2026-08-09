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
//! The projection identity itself (descriptor, generating event, overlaid
//! bytes) is reducer state — see `reduce::{descriptor, project_belief}`;
//! this module consumes that complete result, never a file hash alone.
//!
//! `.cerebro/projection-manifest.json` travels with the vault and stays
//! under the `.cerebro/` blanket gitignore/self-heal.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::reduce::{project_belief, EpistemicState};

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
    state: &EpistemicState,
) -> Result<Option<Manifest>, String> {
    let knowledge = vault.join("knowledge");
    let mut entries = BTreeMap::new();
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
            let belief_id = super::schema::migrate_id(store_id, "belief", &rel);
            if !state.beliefs.contains_key(&belief_id) {
                return Ok(None); // a file the ledger cannot explain
            }
            let projection = project_belief(state, &belief_id)?;
            let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
            if projection.bytes.as_bytes() != bytes.as_slice() {
                return Ok(None); // bytes disagree — reconciliation's problem
            }
            entries.insert(
                format!("knowledge/{rel}"),
                ManifestEntry {
                    belief_id,
                    projected_revision: projection.projected_revision,
                    belief_revision_event: projection.belief_revision_event,
                    generating_event: projection.generating_event,
                    projection_state_digest: projection.projection_state_digest,
                    content_hash: projection.content_hash,
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
    use super::super::reduce::{descriptor, reduce};
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
    fn the_projection_head_outranks_the_revision_event_when_review_advanced() {
        let vault = corpus_copy("manifest-descriptor");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);

        // A verified concept: its attestation was appended AFTER creation,
        // so the generating event is the attestation, not the revision.
        let verified = state
            .beliefs
            .values()
            .find(|b| b.attested.is_some())
            .expect("the corpus has verified concepts");
        let described = descriptor(&state, verified);
        assert!(!described.review_event_ids.is_empty());
        assert_eq!(
            verified.projection_head_event,
            *described.review_event_ids.last().unwrap(),
            "review state is the newest projection transition"
        );
        assert_ne!(verified.projection_head_event, verified.current().event_id);
        // Digest is deterministic and moves when review state moves.
        assert_eq!(
            described.digest().unwrap(),
            descriptor(&state, verified).digest().unwrap()
        );
        let mut without_review = described.clone();
        without_review.review_event_ids.clear();
        assert_ne!(
            described.digest().unwrap(),
            without_review.digest().unwrap()
        );

        // An unverified, relation-less, alias-less concept's head IS its
        // revision event.
        let plain = state
            .beliefs
            .values()
            .find(|b| {
                b.attested.is_none() && {
                    let d = descriptor(&state, b);
                    d.relation_transition_heads.is_empty() && d.alias_event_ids.is_empty()
                }
            })
            .expect("the corpus has plain concepts");
        assert_eq!(plain.projection_head_event, plain.current().event_id);
        let _ = std::fs::remove_dir_all(&vault);
    }
}
