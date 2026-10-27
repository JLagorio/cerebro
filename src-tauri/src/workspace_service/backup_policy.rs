//! Shared native workflow limits and compiled restore child names.
use serde::Deserialize;
use std::{path::{Component, Path}, sync::OnceLock};
const POLICY: &str = include_str!("../../../shared/policy/backup-workflow.v1.json");
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RestoreChildren {
    pub bodies: String,
    pub metadata: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DestinationNames { pub backup_prefix: String, pub restore_prefix: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowRules {
    version: u32,
    pub pending_lease_seconds: u64,
    pub max_pending_workflows: usize,
    pub max_active_workers: usize,
    pub max_terminal_outcomes: usize,
    pub restore_children: RestoreChildren,
    pub destination_names: DestinationNames,
}
fn one_leaf(value: &str) -> bool {
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}
pub(crate) fn rules() -> &'static WorkflowRules {
    static RULES: OnceLock<WorkflowRules> = OnceLock::new();
    RULES.get_or_init(|| {
        let rules: WorkflowRules = serde_json::from_str(POLICY).expect("compiled backup workflow policy");
        // This interpreter supports one slot/outcome; a policy change cannot
        // silently widen that implementation into a queue or multiple writers.
        assert!(rules.version == 1 && rules.pending_lease_seconds > 0
            && rules.max_pending_workflows == 1 && rules.max_active_workers == 1
            && rules.max_terminal_outcomes == 1
            && one_leaf(&rules.destination_names.backup_prefix) && one_leaf(&rules.destination_names.restore_prefix)
            && one_leaf(&rules.restore_children.bodies) && one_leaf(&rules.restore_children.metadata)
            && rules.restore_children.bodies.to_lowercase() != rules.restore_children.metadata.to_lowercase());
        rules
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn compiled_backup_workflow_policy_matches_disk_and_digest() {
        let expected = include_str!("../../../shared/policy/backup-workflow.v1.sha256").trim();
        assert_eq!(format!("{:x}", Sha256::digest(POLICY.as_bytes())), expected);
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/policy");
        assert_eq!(std::fs::read_to_string(root.join("backup-workflow.v1.json")).unwrap(), POLICY);
        let rules = rules();
        assert!(one_leaf(&rules.restore_children.bodies));
        assert!(one_leaf(&rules.restore_children.metadata));
    }
    #[test]
    #[ignore = "explicit digest regeneration after reviewed backup workflow policy changes"]
    fn write_backup_workflow_digest() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/policy");
        let bytes = std::fs::read(root.join("backup-workflow.v1.json")).unwrap();
        assert_eq!(bytes, POLICY.as_bytes(), "rebuild before regenerating the compiled artifact anchor");
        std::fs::write(root.join("backup-workflow.v1.sha256"), format!("{:x}\n", Sha256::digest(bytes))).unwrap();
    }
}
