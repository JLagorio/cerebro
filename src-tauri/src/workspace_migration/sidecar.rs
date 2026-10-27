//! Disposable JSON sidecar adapter; visible Markdown is the body authority.
use super::comparison::{
    atomic_write, decode_metadata, encoded, read_file, safe_path, validate_state, State,
    WorkspaceStore,
};
use crate::workspace_service::types::prototype::{error, Record, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    revision: u64,
    hash: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    state: State,
    records: BTreeMap<String, Reference>,
}

pub(crate) struct Sidecar {
    root: PathBuf,
    metadata: PathBuf,
}
impl Sidecar {
    pub(crate) fn new(root: PathBuf, metadata: PathBuf) -> Self {
        Self { root, metadata }
    }
}
impl WorkspaceStore for Sidecar {
    fn root(&self) -> &Path {
        &self.root
    }
    fn metadata_root(&self) -> &Path {
        &self.metadata
    }
    fn load_state(&self) -> Result<State> {
        let bytes = read_file(
            &safe_path(&self.metadata, "workspace-manifest.json")?,
            32 * 1024 * 1024,
        )?;
        let mut manifest: Manifest = decode_metadata(&bytes)?;
        if !manifest.state.records.is_empty()
            || manifest.records.len() > super::syntax::limits().max_files
        {
            return Err(error("invalid_metadata", "Invalid sidecar manifest."));
        }
        super::identity::read_manifest(&encoded(&manifest.state.identity)?)
            .map_err(|e| error(e.kind, e.detail))?;
        for (id, reference) in manifest.records {
            // Validate the identity through the manifest before using it in a file path.
            if !manifest
                .state
                .identity
                .records
                .iter()
                .any(|row| row.record_id == id)
            {
                return Err(error("invalid_metadata", "Unknown sidecar identity."));
            }
            let path = format!("records/{id}/{}.json", reference.revision);
            let bytes = read_file(&safe_path(&self.metadata, &path)?, 256 * 1024)?;
            if crate::ledger::sha256_hex(&bytes) != reference.hash {
                return Err(error("invalid_metadata", "Sidecar hash mismatch."));
            }
            let record: Record = decode_metadata(&bytes)?;
            if record.id != id || record.version.metadata_revision != reference.revision {
                return Err(error(
                    "invalid_metadata",
                    "Sidecar revision/identity mismatch.",
                ));
            }
            manifest.state.records.insert(id, record);
        }
        validate_state(&manifest.state)?;
        Ok(manifest.state)
    }
    fn commit_state(&mut self, state: &State) -> Result<()> {
        validate_state(state)?;
        let mut references = BTreeMap::new();
        for (id, record) in &state.records {
            let bytes = encoded(record)?;
            let path = safe_path(
                &self.metadata,
                &format!("records/{id}/{}.json", record.version.metadata_revision),
            )?;
            if path.exists() {
                if read_file(&path, 256 * 1024)? != bytes {
                    return Err(error(
                        "revision_conflict",
                        "Immutable sidecar generation already contains other metadata.",
                    ));
                }
            } else {
                atomic_write(&path, &bytes)?;
            }
            references.insert(
                id.clone(),
                Reference {
                    revision: record.version.metadata_revision,
                    hash: crate::ledger::sha256_hex(&bytes),
                },
            );
        }
        let mut header = state.clone();
        header.records.clear();
        atomic_write(
            &safe_path(&self.metadata, "workspace-manifest.json")?,
            &encoded(&Manifest {
                state: header,
                records: references,
            })?,
        )
    }
}
