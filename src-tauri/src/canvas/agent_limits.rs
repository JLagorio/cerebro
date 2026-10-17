use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

pub const LIMITS_JSON: &str = include_str!("../../../shared/canvas/agent-limits.v1.json");
#[cfg(test)]
const DIGEST_PATH: &str = "shared/canvas/agent-limits.v1.sha256";
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanvasLimits {
    pub format: u64,
    pub artifact_version: u64,
    pub read: ReadLimits,
    pub edit: EditLimits,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadLimits {
    pub nodes: usize,
    pub bytes: usize,
    pub ids: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditLimits {
    pub ops: usize,
    pub id_chars: usize,
    pub text_chars: usize,
    pub label_chars: usize,
    pub file_chars: usize,
    pub subpath_chars: usize,
    pub url_chars: usize,
}
fn keys(value: &Value, expected: &[&str], path: &str) -> Result<(), String> {
    if !value.as_object().is_some_and(|o| {
        o.len() == expected.len() && expected.iter().all(|key| o.contains_key(*key))
    }) {
        return Err(format!(
            "Canvas agent limits {path} must contain only {}.",
            expected.join(", ")
        ));
    }
    Ok(())
}
fn positive(value: &mut Value, path: &str) -> Result<(), String> {
    let number = value
        .as_f64()
        .filter(|n| *n > 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0)
        .ok_or_else(|| format!("Canvas agent limits {path} must be a positive whole number."))?;
    *value = Value::from(number as u64);
    Ok(())
}
pub fn parse(source: &str) -> Result<CanvasLimits, String> {
    let mut value: Value =
        serde_json::from_str(source).map_err(|_| "Canvas agent limits format must be 1.")?;
    if value.get("format").and_then(Value::as_f64) != Some(1.0) {
        return Err("Canvas agent limits format must be 1.".into());
    }
    keys(
        &value,
        &["format", "artifact_version", "read", "edit"],
        "root",
    )?;
    positive(&mut value["artifact_version"], "artifact_version")?;
    keys(&value["read"], &["nodes", "bytes", "ids"], "read")?;
    for field in ["nodes", "bytes", "ids"] {
        positive(&mut value["read"][field], &format!("read.{field}"))?;
    }
    let edit = [
        "ops",
        "id_chars",
        "text_chars",
        "label_chars",
        "file_chars",
        "subpath_chars",
        "url_chars",
    ];
    keys(&value["edit"], &edit, "edit")?;
    for field in edit {
        positive(&mut value["edit"][field], &format!("edit.{field}"))?;
    }
    value["format"] = Value::from(1);
    serde_json::from_value(value).map_err(|_| "Canvas agent limits could not be read.".into())
}
pub fn table() -> &'static CanvasLimits {
    static TABLE: OnceLock<CanvasLimits> = OnceLock::new();
    TABLE.get_or_init(|| parse(LIMITS_JSON).expect("the compiled canvas agent limits validate"))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn repo(path: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(path)
    }
    #[test]
    fn the_loaded_bytes_match_the_committed_digest() {
        assert_eq!(
            crate::ledger::sha256_hex(LIMITS_JSON.as_bytes()),
            std::fs::read_to_string(repo(DIGEST_PATH)).unwrap().trim()
        );
        assert_eq!(table().format, 1);
        assert_eq!(table().artifact_version, 2);
    }
    #[test]
    #[ignore = "deliberate artifact edit: regenerates the shared digest"]
    fn write_canvas_agent_limits_digest() {
        std::fs::write(
            repo(DIGEST_PATH),
            format!("{}\n", crate::ledger::sha256_hex(LIMITS_JSON.as_bytes())),
        )
        .unwrap();
    }
    #[test]
    fn replays_the_shared_limit_cases() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../shared/canvas/agent-limit-cases.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let mut value: Value = serde_json::from_str(LIMITS_JSON).unwrap();
            if let Some(path) = case["path"].as_array() {
                let mut slot = &mut value;
                for key in path {
                    slot = &mut slot[key.as_str().unwrap()];
                }
                *slot = case["value"].clone();
            } else {
                value = case["value"].clone();
            }
            let result = parse(&value.to_string());
            if let Some(reason) = case["error"].as_str() {
                assert_eq!(result.unwrap_err(), reason, "{}", case["name"]);
            } else {
                assert!(result.is_ok(), "{}: {result:?}", case["name"]);
            }
        }
    }
}
