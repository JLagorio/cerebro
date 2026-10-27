//! Shared native admission policy bytes/types. No authority constructor.
use serde::Deserialize;
use std::sync::OnceLock;

pub(super) const POLICY: &str = include_str!("../../../shared/policy/actions.v1.json");
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdmissionLimits {
    pub identity_bytes: usize,
    pub canonical_path_bytes: usize,
    pub process_session_bytes: usize,
    pub grant_capabilities: usize,
    pub grant_bytes: usize,
    pub grants_per_run: usize,
    pub ancestry_depth: usize,
    pub catalog_page_size: usize,
    pub cursor_bytes: usize,
}
// Native registration reads only its four bounds from the same immutable table.
// Full action parsing below remains strict in schema.rs; no grants are promoted.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLimits {
    pub identity_bytes: usize,
    pub canonical_path_bytes: usize,
    pub process_session_bytes: usize,
    pub ancestry_depth: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdmissionRules<L = NativeLimits> {
    pub version: u32,
    pub default_grant: String,
    pub owner_realm: String,
    pub owner_storage_key: String,
    pub source_kinds: Vec<String>,
    pub grant_input_scopes: Vec<String>,
    pub parent_grant_rule: String,
    pub ordinary_handoff_child_job_id: String,
    pub child_job_id_rule: String,
    pub normal_parent_completion: String,
    pub parent_stop_or_revocation: String,
    pub historical_read: String,
    pub legacy_admission: String,
    pub no_store_admission: String,
    pub limits: L,
}

// The action schema loader validates the rest of the same immutable artifact.
// This narrow envelope is for native-run provenance without promoting actions.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    version: u32,
    admission: AdmissionRules,
}

pub(super) fn validate<L>(rules: &AdmissionRules<L>) {
    assert_eq!(rules.version, 1);
    assert_eq!(rules.default_grant, "deny");
    assert_eq!(rules.owner_realm, "verified_single_local_app_owner");
    assert_eq!(rules.owner_storage_key, "human:me");
    assert_eq!(
        rules.source_kinds,
        vec!["attended_operation", "run", "client", "job"]
    );
    assert_eq!(
        rules.grant_input_scopes,
        vec!["all_valid_inputs", "exact_canonical_input"]
    );
    assert_eq!(rules.parent_grant_rule, "explicit_intersection_only");
    assert_eq!(rules.ordinary_handoff_child_job_id, "absent");
    assert_eq!(rules.child_job_id_rule, "actual_m95_job_claim_proof_only");
    assert_eq!(
        rules.normal_parent_completion,
        "preserve_explicit_live_child_grants"
    );
    assert_eq!(
        rules.parent_stop_or_revocation,
        "deny_future_descendant_claims"
    );
    assert_eq!(rules.historical_read, "verified_native_owner_read_only");
    assert_eq!(rules.legacy_admission, "deny_without_native_provenance");
    assert_eq!(rules.no_store_admission, "unavailable");
}
pub(super) fn admission_rules() -> &'static AdmissionRules {
    static RULES: OnceLock<AdmissionRules> = OnceLock::new();
    RULES.get_or_init(|| {
        let envelope: Envelope = serde_json::from_str(POLICY).expect("native admission policy");
        assert_eq!(envelope.version, 1);
        validate(&envelope.admission);
        envelope.admission
    })
}
