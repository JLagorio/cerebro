//! UUID proposals are minted only on explicit consumption of a reviewed draft.
//! The returned manifest is in memory, not a durable publication or authorization.
use super::inventory::{MigrationError, MigrationInventory};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordIdentity {
    pub record_id: String,
    pub path: String,
    pub source_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceManifest {
    pub format: u8,
    pub workspace_id: String,
    pub records: Vec<RecordIdentity>,
}
/// Supplied by a trusted registration/test caller, never derived from the manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceBinding {
    pub workspace_id: String,
    pub canonical_root: PathBuf,
}
#[derive(Debug)]
pub struct ExistingIdentity {
    pub manifest: WorkspaceManifest,
    pub binding: WorkspaceBinding,
}
#[derive(Debug)]
pub struct ExplicitMove {
    pub record_id: String,
    pub from: String,
    pub to: String,
    pub expected_source_hash: String,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PlannedRecord {
    pub record_id: Option<String>,
    pub path: String,
    pub source_hash: String,
}
/// Deliberately not Clone: consume the reviewed proposal once to allocate IDs.
#[derive(Debug, PartialEq, Eq)]
pub struct IdentityPlan {
    workspace_id: Option<String>,
    records: Vec<PlannedRecord>,
    source_root: PathBuf,
    reserved_ids: BTreeSet<String>,
}

use super::{
    inventory::{valid_path, Carrier, Status},
    syntax::{failure, limits},
};
use std::collections::BTreeMap;

pub(crate) fn is_uuid_v4(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}
fn hash_valid(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn validate_manifest(manifest: &WorkspaceManifest) -> Result<(), MigrationError> {
    if manifest.format != 1
        || !is_uuid_v4(&manifest.workspace_id)
        || manifest.records.len() > limits().max_files
    {
        return Err(failure(
            "invalid_manifest",
            "Unsupported identity format, workspace UUID or record count.",
        ));
    }
    let (mut ids, mut paths) = (
        BTreeSet::from([manifest.workspace_id.as_str()]),
        BTreeSet::new(),
    );
    for record in &manifest.records {
        if !is_uuid_v4(&record.record_id)
            || !hash_valid(&record.source_hash)
            || !valid_path(&record.path)
        {
            return Err(failure(
                "invalid_manifest",
                "Identity manifest contains an invalid UUID, source hash or path.",
            ));
        }
        if !ids.insert(&record.record_id) || !paths.insert(&record.path) {
            return Err(failure(
                "duplicate_identity",
                "Record UUIDs and manifest paths must be unique.",
            ));
        }
    }
    Ok(())
}
pub fn read_manifest(bytes: &[u8]) -> Result<WorkspaceManifest, MigrationError> {
    if bytes.len() > limits().max_file_bytes {
        return Err(failure(
            "invalid_manifest",
            "Identity manifest exceeds its byte limit.",
        ));
    }
    let manifest = serde_json::from_slice(bytes).map_err(|_| {
        failure(
            "invalid_manifest",
            "Existing identity manifest could not be decoded; it is never repaired by reminting.",
        )
    })?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

pub fn plan_identities(
    inventory: &MigrationInventory,
    existing: Option<&ExistingIdentity>,
    moves: &[ExplicitMove],
    known_bindings: &[WorkspaceBinding],
) -> Result<IdentityPlan, MigrationError> {
    let mut registered = BTreeMap::new();
    let mut root_ids = BTreeMap::new();
    let mut reserved_ids = BTreeSet::new();
    for binding in known_bindings {
        if !is_uuid_v4(&binding.workspace_id) {
            return Err(failure(
                "invalid_binding",
                "A trusted binding has an invalid workspace UUID.",
            ));
        }
        if registered
            .insert(&binding.workspace_id, &binding.canonical_root)
            .is_some_and(|root| root != &binding.canonical_root)
            || root_ids
                .insert(&binding.canonical_root, &binding.workspace_id)
                .is_some_and(|id| id != &binding.workspace_id)
        {
            return Err(failure(
                "workspace_collision",
                "Trusted registrations contain a workspace/root collision.",
            ));
        }
        reserved_ids.insert(binding.workspace_id.clone());
    }
    if existing.is_none() && root_ids.contains_key(&inventory.root) {
        return Err(failure(
            "manifest_required",
            "An already registered root needs its existing manifest, never a new identity.",
        ));
    }
    if moves.len() > limits().max_files {
        return Err(failure("invalid_move", "Too many identity moves."));
    }
    let mut old_by_path = BTreeMap::new();
    let workspace_id = if let Some(existing) = existing {
        validate_manifest(&existing.manifest)?;
        if existing.binding.workspace_id != existing.manifest.workspace_id
            || existing.binding.canonical_root != inventory.root
        {
            return Err(failure(
                "unbound_manifest",
                "Manifest identity must match a separately trusted workspace/root binding.",
            ));
        }
        if registered
            .get(&existing.manifest.workspace_id)
            .is_some_and(|root| **root != inventory.root)
            || root_ids
                .get(&inventory.root)
                .is_some_and(|id| **id != existing.manifest.workspace_id)
        {
            return Err(failure(
                "workspace_collision",
                "This workspace UUID is bound to another root or identity.",
            ));
        }
        reserved_ids.insert(existing.manifest.workspace_id.clone());
        for record in &existing.manifest.records {
            old_by_path.insert(record.path.as_str(), record);
            reserved_ids.insert(record.record_id.clone());
        }
        Some(existing.manifest.workspace_id.clone())
    } else {
        None
    };
    let mut current = BTreeMap::new();
    for row in &inventory.rows {
        if !matches!(row.carrier, Carrier::Markdown | Carrier::ViewYaml) {
            continue;
        }
        if matches!(row.status, Status::Blocked | Status::Ambiguous) {
            return Err(failure(
                "inventory_not_ready",
                "Identity planning requires readable, unambiguous requested records.",
            ));
        }
        let original = row.original.as_ref().ok_or_else(|| {
            failure(
                "inventory_not_ready",
                "A requested record has no original bytes/hash.",
            )
        })?;
        current.insert(row.path.as_str(), original.sha256.as_str());
    }
    let (mut moved_ids, mut moved_from, mut moved_to) =
        (BTreeSet::new(), BTreeSet::new(), BTreeMap::new());
    for movement in moves {
        if !valid_path(&movement.from) || !valid_path(&movement.to) || movement.from == movement.to
        {
            return Err(failure(
                "invalid_move",
                "An explicit move requires distinct valid relative paths.",
            ));
        }
        let prior = old_by_path.get(movement.from.as_str()).ok_or_else(|| {
            failure(
                "invalid_move",
                "Move source is not a committed manifest record.",
            )
        })?;
        if prior.record_id != movement.record_id
            || !moved_ids.insert(movement.record_id.as_str())
            || !moved_from.insert(movement.from.as_str())
            || moved_to
                .insert(movement.to.as_str(), prior.record_id.as_str())
                .is_some()
        {
            return Err(failure(
                "invalid_move",
                "Move identity and endpoints must match one committed record exactly once.",
            ));
        }
        if current.contains_key(movement.from.as_str())
            || old_by_path.contains_key(movement.to.as_str())
        {
            return Err(failure(
                "ambiguous_move",
                "Move source or destination is also an inventoried/committed record.",
            ));
        }
        if current.get(movement.to.as_str()).copied()
            != Some(movement.expected_source_hash.as_str())
        {
            return Err(failure(
                "stale_move",
                "Move destination is outside scope or its original bytes changed.",
            ));
        }
    }
    for path in old_by_path.keys() {
        if !current.contains_key(path) && !moved_from.contains(path) {
            return Err(failure("unmatched_manifest_record", "A prior record is missing/outside requested scope; declare its move explicitly before proposing identities."));
        }
    }
    let records = current
        .into_iter()
        .map(|(path, hash)| PlannedRecord {
            record_id: moved_to
                .get(path)
                .map(|id| (*id).to_owned())
                .or_else(|| old_by_path.get(path).map(|record| record.record_id.clone())),
            path: path.into(),
            source_hash: hash.into(),
        })
        .collect();
    Ok(IdentityPlan {
        source_root: inventory.root.clone(),
        workspace_id,
        records,
        reserved_ids,
    })
}
impl IdentityPlan {
    pub(super) fn check_inventory(
        &self,
        inventory: &MigrationInventory,
    ) -> Result<(), MigrationError> {
        if self.source_root != inventory.root {
            return Err(failure(
                "identity_binding_changed",
                "The approved identity plan belongs to another source root.",
            ));
        }
        let cap = limits();
        if inventory.rows.len() > cap.max_files
            || inventory.coverage.requested_paths.len() > cap.max_files
        {
            return Err(failure(
                "source_limit",
                "Reviewed semantic inventory exceeds its file limit.",
            ));
        }
        let mut total = 0_usize;
        for row in &inventory.rows {
            if let Some(original) = &row.original {
                total = total
                    .checked_add(original.bytes.len())
                    .filter(|n| *n <= cap.max_total_bytes)
                    .ok_or_else(|| {
                        failure(
                            "source_limit",
                            "Reviewed semantic inventory exceeds its aggregate byte limit.",
                        )
                    })?;
                if original.bytes.len() > cap.max_file_bytes {
                    return Err(failure(
                        "source_limit",
                        "Reviewed source exceeds its per-file byte limit.",
                    ));
                }
            }
        }
        let current: BTreeMap<_, _> = inventory
            .rows
            .iter()
            .filter(|row| matches!(row.carrier, Carrier::Markdown | Carrier::ViewYaml))
            .map(|row| {
                Ok((
                    row.path.as_str(),
                    row.original
                        .as_ref()
                        .ok_or_else(|| {
                            failure(
                                "inventory_not_ready",
                                "Reviewed identity source is unavailable.",
                            )
                        })?
                        .sha256
                        .as_str(),
                ))
            })
            .collect::<Result<_, MigrationError>>()?;
        let approved: BTreeMap<_, _> = self
            .records
            .iter()
            .map(|record| (record.path.as_str(), record.source_hash.as_str()))
            .collect();
        if current.len()
            != inventory
                .rows
                .iter()
                .filter(|row| matches!(row.carrier, Carrier::Markdown | Carrier::ViewYaml))
                .count()
            || current != approved
        {
            return Err(failure(
                "identity_binding_changed",
                "The approved identity path/hash set differs from the reviewed inventory.",
            ));
        }
        Ok(())
    }
    pub(crate) fn into_proposed_manifest(
        mut self,
        mut mint: impl FnMut() -> String,
    ) -> Result<WorkspaceManifest, MigrationError> {
        let mut next = || {
            let id = mint();
            if !is_uuid_v4(&id) || !self.reserved_ids.insert(id.clone()) {
                return Err(failure(
                    "invalid_mint",
                    "UUID proposal is invalid or collides; no automatic remint is performed.",
                ));
            }
            Ok(id)
        };
        let workspace_id = match self.workspace_id {
            Some(id) => id,
            None => next()?,
        };
        let mut records = Vec::with_capacity(self.records.len());
        for record in self.records {
            records.push(RecordIdentity {
                record_id: match record.record_id {
                    Some(id) => id,
                    None => next()?,
                },
                path: record.path,
                source_hash: record.source_hash,
            });
        }
        let proposed = WorkspaceManifest {
            format: 1,
            workspace_id,
            records,
        };
        validate_manifest(&proposed)?;
        Ok(proposed)
    }
}
pub(crate) fn mint_uuid_v4() -> String {
    // An explicit caller may inject this existing rand-backed mint into a
    // consumed draft. UUID bits are set here; no identity is derived from data.
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        vault::testutil,
        workspace_migration::inventory::{inventory_workspace, InventoryScope},
    };
    const WORKSPACE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const RECORD: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fn inventory(root: &std::path::Path, paths: &[&str]) -> MigrationInventory {
        inventory_workspace(
            root,
            &InventoryScope {
                paths: paths.iter().map(|p| p.to_string()).collect(),
            },
        )
        .unwrap()
    }
    fn manifest(path: &str, hash: &str) -> WorkspaceManifest {
        WorkspaceManifest {
            format: 1,
            workspace_id: WORKSPACE.into(),
            records: vec![RecordIdentity {
                record_id: RECORD.into(),
                path: path.into(),
                source_hash: hash.into(),
            }],
        }
    }
    fn existing(root: &std::path::Path, manifest: WorkspaceManifest) -> ExistingIdentity {
        ExistingIdentity {
            manifest,
            binding: WorkspaceBinding {
                workspace_id: WORKSPACE.into(),
                canonical_root: std::fs::canonicalize(root).unwrap(),
            },
        }
    }

    #[test]
    fn drafts_do_not_mint_and_existing_manifest_replay_is_deterministic() {
        let root = testutil::temp_vault("identity-draft");
        testutil::write(&root, "one.md", "# One\n");
        testutil::write(&root, "two.md", "# Two\n");
        let inventory = inventory(&root, &["two.md", "one.md"]);
        let plan = plan_identities(&inventory, None, &[], &[]).unwrap();
        assert!(plan.workspace_id.is_none());
        assert!(plan.records.iter().all(|r| r.record_id.is_none()));
        let mut calls = 0;
        let proposed = plan
            .into_proposed_manifest(|| {
                calls += 1;
                format!("00000000-0000-4000-8000-{calls:012}")
            })
            .unwrap();
        assert_eq!(calls, 3);
        let loaded = read_manifest(&serde_json::to_vec(&proposed).unwrap()).unwrap();
        let trusted = ExistingIdentity {
            binding: WorkspaceBinding {
                workspace_id: loaded.workspace_id.clone(),
                canonical_root: inventory.root.clone(),
            },
            manifest: loaded,
        };
        assert_eq!(
            plan_identities(&inventory, Some(&trusted), &[], &[]).unwrap(),
            plan_identities(&inventory, Some(&trusted), &[], &[]).unwrap()
        );
        let replay = plan_identities(&inventory, Some(&trusted), &[], &[])
            .unwrap()
            .into_proposed_manifest(|| panic!("committed IDs must not remint"))
            .unwrap();
        assert_eq!(replay, proposed);
        assert!(!root.join(".cerebro").exists());
        assert_eq!(std::fs::read(root.join("one.md")).unwrap(), b"# One\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn moved_agent_requires_an_explicit_move_and_retains_the_committed_id() {
        let root = testutil::temp_vault("identity-agent-move");
        let source = "---\ntype: Agent\nname: Helper\n---\n# Instructions\n";
        testutil::write(&root, "moved/helper.md", source);
        let inventory = inventory(&root, &["moved/helper.md"]);
        let hash = crate::ledger::sha256_hex(source.as_bytes());
        let trusted = existing(&root, manifest("agents/helper.md", &hash));
        assert!(plan_identities(&inventory, Some(&trusted), &[], &[]).is_err());
        let movement = ExplicitMove {
            record_id: RECORD.into(),
            from: "agents/helper.md".into(),
            to: "moved/helper.md".into(),
            expected_source_hash: hash,
        };
        let proposed = plan_identities(&inventory, Some(&trusted), &[movement], &[])
            .unwrap()
            .into_proposed_manifest(|| panic!("move never mints"))
            .unwrap();
        assert_eq!(proposed.records[0].record_id, RECORD);
        assert_eq!(proposed.records[0].path, "moved/helper.md");
        assert_eq!(
            std::fs::read(root.join("moved/helper.md")).unwrap(),
            source.as_bytes()
        );
        assert_eq!(inventory.rows[0].declared_type.as_deref(), Some("Agent"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_semantic_read_cannot_be_accepted_as_unambiguous_identity_evidence() {
        let root = testutil::temp_vault("identity-semantic-read");
        let source = "---\nnumber: 18446744073709551616\nproject: \"[[Missing]]\"\n---\n# Body\n";
        testutil::write(&root, "large.md", source);
        let inventory = inventory(&root, &["large.md"]);
        let result = plan_identities(&inventory, None, &[], &[]);
        assert_eq!(result.unwrap_err().kind, "inventory_not_ready");
        assert_eq!(
            std::fs::read(root.join("large.md")).unwrap(),
            source.as_bytes()
        );
        assert!(!root.join(".cerebro").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn copying_equal_bytes_does_not_infer_record_identity() {
        let root = testutil::temp_vault("identity-copy");
        for path in ["one.md", "copy.md"] {
            testutil::write(&root, path, "# Same\n");
        }
        let inventory = inventory(&root, &["one.md", "copy.md"]);
        let trusted = existing(
            &root,
            manifest("one.md", &crate::ledger::sha256_hex(b"# Same\n")),
        );
        let plan = plan_identities(&inventory, Some(&trusted), &[], &[]).unwrap();
        assert!(plan
            .records
            .iter()
            .find(|r| r.path == "copy.md")
            .unwrap()
            .record_id
            .is_none());
        assert_eq!(
            plan.records
                .iter()
                .find(|r| r.path == "one.md")
                .unwrap()
                .record_id
                .as_deref(),
            Some(RECORD)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_or_unbound_manifest_claims_and_stale_moves_are_rejected() {
        let root = testutil::temp_vault("identity-collision");
        testutil::write(&root, "one.md", "# One\n");
        let inventory = inventory(&root, &["one.md"]);
        let hash = crate::ledger::sha256_hex(b"# One\n");
        let mut duplicated = manifest("one.md", &hash);
        duplicated.records.push(duplicated.records[0].clone());
        assert!(plan_identities(&inventory, Some(&existing(&root, duplicated)), &[], &[]).is_err());
        let mut unbound = existing(&root, manifest("one.md", &hash));
        unbound.binding.workspace_id = RECORD.into();
        assert!(plan_identities(&inventory, Some(&unbound), &[], &[]).is_err());
        let trusted = existing(&root, manifest("one.md", &hash));
        let foreign = WorkspaceBinding {
            workspace_id: WORKSPACE.into(),
            canonical_root: root.join("another-root"),
        };
        assert!(plan_identities(&inventory, Some(&trusted), &[], &[foreign]).is_err());
        let prior = existing(&root, manifest("old.md", &hash));
        let stale = ExplicitMove {
            record_id: RECORD.into(),
            from: "old.md".into(),
            to: "one.md".into(),
            expected_source_hash: "0".repeat(64),
        };
        assert!(plan_identities(&inventory, Some(&prior), &[stale], &[]).is_err());
        assert_eq!(std::fs::read(root.join("one.md")).unwrap(), b"# One\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn shared_manifest_collisions_are_refused_without_repair() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/workspace/migration-cases.v1.json"
        ))
        .unwrap();
        for case in cases["identityCases"].as_array().unwrap() {
            let bytes = serde_json::to_vec(&case["manifest"]).unwrap();
            let before = bytes.clone();
            let error = read_manifest(&bytes).unwrap_err();
            assert_eq!(
                error.kind,
                case["errorKind"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(bytes, before);
        }
    }

    #[test]
    fn root_authority_and_missing_scope_cannot_be_replaced_by_manifest_claims() {
        let root = testutil::temp_vault("identity-root-scope");
        testutil::write(&root, "one.md", "# One\n");
        let current = inventory(&root, &["one.md"]);
        let hash = crate::ledger::sha256_hex(b"# One\n");
        let trusted = existing(&root, manifest("one.md", &hash));
        assert_eq!(
            plan_identities(&current, None, &[], std::slice::from_ref(&trusted.binding))
                .unwrap_err()
                .kind,
            "manifest_required"
        );
        let mut wrong_root = existing(&root, manifest("one.md", &hash));
        wrong_root.binding.canonical_root = root.join("different-root");
        assert_eq!(
            plan_identities(&current, Some(&wrong_root), &[], &[])
                .unwrap_err()
                .kind,
            "unbound_manifest"
        );
        let omitted = inventory(&root, &[]);
        assert_eq!(
            plan_identities(&omitted, Some(&trusted), &[], &[])
                .unwrap_err()
                .kind,
            "unmatched_manifest_record"
        );
        testutil::write(&root, "copy.md", "# One\n");
        let both = inventory(&root, &["one.md", "copy.md"]);
        let movement = ExplicitMove {
            record_id: RECORD.into(),
            from: "one.md".into(),
            to: "copy.md".into(),
            expected_source_hash: hash,
        };
        assert_eq!(
            plan_identities(&both, Some(&trusted), &[movement], &[])
                .unwrap_err()
                .kind,
            "ambiguous_move"
        );
        assert!(!root.join(".cerebro").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_manifest_and_invalid_mint_are_never_repaired_or_rekeyed() {
        assert!(read_manifest(b"{}").is_err());
        assert!(read_manifest(format!(r#"{{"format":1,"workspace_id":"{WORKSPACE}","workspace_id":"{RECORD}","records":[]}}"#).as_bytes()).is_err());
        let root = testutil::temp_vault("identity-invalid-mint");
        testutil::write(&root, "one.md", "# One\n");
        let inventory = inventory(&root, &["one.md"]);
        assert!(plan_identities(&inventory, None, &[], &[])
            .unwrap()
            .into_proposed_manifest(|| "filename-is-not-an-id".into())
            .is_err());
        assert!(plan_identities(&inventory, None, &[], &[])
            .unwrap()
            .into_proposed_manifest(|| WORKSPACE.into())
            .is_err());
        let id = mint_uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(["8", "9", "a", "b"].contains(&&id[19..20]));
        let _ = std::fs::remove_dir_all(root);
    }
}
