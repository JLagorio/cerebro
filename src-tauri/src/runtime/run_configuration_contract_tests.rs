use super::*;
fn bundle() -> serde_json::Value {
    serde_json::json!({"version":1,"types":{
        "RunConfigurationManifestV1":schemars::schema_for!(RunConfigurationManifestV1),
        "CommandReply":schemars::schema_for!(ConfigurationReply)
    }})
}
fn path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../shared/run-configuration/contracts.v1.json")
}
#[test]
fn rust_configuration_declarations_match_committed_schema() {
    let committed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path()).unwrap()).unwrap();
    assert_eq!(
        bundle(),
        committed,
        "regenerate the Rust-owned configuration schema before TS projection"
    );
}
#[test]
#[ignore = "Root explicitly exports the Rust-owned run-configuration schema before its third TS contract bundle"]
fn export_run_configuration_contract_schema() {
    let path = path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&bundle()).unwrap()),
    )
    .unwrap();
}
