//! Shared vocabulary for the selected store's private paired-change journal.
//! This is not a global journal, activation producer or authority constructor.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Names {
    pub lock: String,
    pub pending: String,
    pub prepare_prefix: String,
    pub retired_prefix: String,
    pub envelope: String,
    pub before_body: String,
    pub after_body: String,
    pub target_temp_prefix: String,
    pub target_temp_suffix: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Limits {
    pub envelope_bytes: u64,
    pub artifact_directories: usize,
    pub files_per_artifact: usize,
    pub target_temps: u64,
    pub logical_artifact_bytes: u64,
    pub sqlite_rollback_bytes: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Rules {
    pub version: u32,
    pub selected_schema_version: i64,
    pub authority_rules: String,
    pub value_rules: String,
    pub names: Names,
    pub limits: Limits,
    pub blocked_canonical_types: Vec<String>,
    pub operation: String,
}
pub(crate) fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let rules: Rules = serde_json::from_str(include_str!(
            "../../../shared/workspace/paired-change.v1.json"
        ))
        .expect("paired change vocabulary");
        assert_eq!(rules.version, 2);
        assert_eq!(rules.authority_rules, "shared/workspace/authority.v2.json");
        assert_eq!(rules.value_rules, "shared/workspace/values.v1.json");
        assert_eq!(rules.limits.files_per_artifact, 3);
        rules
    })
}
