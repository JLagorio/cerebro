use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

pub const FORMAT_JSON: &str = include_str!("../../../shared/canvas/format.v1.json");
pub const FORMAT_PATH: &str = "shared/canvas/format.v1.json";
pub const DIGEST_PATH: &str = "shared/canvas/format.v1.sha256";

#[derive(Debug, Deserialize)]
pub struct CanvasFormat {
    pub format: u64,
    pub artifact_version: u64,
    pub json_canvas: String,
    pub cerebro_versions: Vec<u64>,
    pub vocab: BTreeMap<String, Vec<String>>,
    pub limits: Limits,
    pub key_order: BTreeMap<String, Vec<String>>,
    pub layout: Layout,
}

#[derive(Debug, Deserialize)]
pub struct Limits {
    pub max_bytes: usize,
    pub max_depth: usize,
    pub max_id_chars: usize,
    pub max_coord: i64,
    pub max_nodes: usize,
    pub max_edges: usize,
    pub max_strokes: usize,
    pub max_ink_points: usize,
    pub max_ink_size: i64,
}

#[derive(Debug, Deserialize)]
pub struct Layout {
    pub indent: String,
    pub trailing_newline: bool,
}

fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn positive(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n > 0.0 && n <= 9_007_199_254_740_991.0 && n.fract() == 0.0)
}
fn strings(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        !a.is_empty()
            && a.iter().all(|s| s.as_str().is_some_and(|s| !s.is_empty()))
            && a.iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
                .len()
                == a.len()
    })
}

/// Validation words match scene/format.ts; a damaged artifact never reaches a reader.
pub fn parse(source: &str) -> Result<CanvasFormat, String> {
    let mut v: Value = serde_json::from_str(source).map_err(|_| "Canvas format must be 1.")?;
    if v.get("format").and_then(Value::as_f64) != Some(1.0) {
        return Err("Canvas format must be 1.".into());
    }
    let root_keys = [
        "format",
        "artifact_version",
        "json_canvas",
        "cerebro_versions",
        "vocab",
        "limits",
        "key_order",
        "layout",
    ];
    let versions_ok = v
        .get("cerebro_versions")
        .and_then(Value::as_array)
        .is_some_and(|a| {
            !a.is_empty()
                && a.iter().all(positive)
                && a.iter()
                    .filter_map(Value::as_f64)
                    .map(|n| n as u64)
                    .collect::<BTreeSet<_>>()
                    .len()
                    == a.len()
        });
    if !exact(&v, &root_keys)
        || !positive(&v["artifact_version"])
        || v["json_canvas"] != "1.0"
        || !versions_ok
    {
        return Err("Canvas format has missing, unknown or invalid fields.".into());
    }
    if !exact(
        &v["vocab"],
        &[
            "node_types",
            "sides",
            "ends",
            "background_styles",
            "color_presets",
            "shapes",
        ],
    ) || !v["vocab"].as_object().unwrap().values().all(strings)
    {
        return Err("Canvas vocabulary must contain each non-empty, unique list.".into());
    }
    if !exact(
        &v["limits"],
        &[
            "max_bytes",
            "max_depth",
            "max_id_chars",
            "max_coord",
            "max_nodes",
            "max_edges",
            "max_strokes",
            "max_ink_points",
            "max_ink_size",
        ],
    ) || !v["limits"].as_object().unwrap().values().all(positive)
    {
        return Err("Canvas limits must be positive whole numbers.".into());
    }
    if !exact(
        &v["key_order"],
        &[
            "board", "text", "file", "link", "group", "edge", "cerebro", "card", "stroke",
        ],
    ) || !v["key_order"].as_object().unwrap().values().all(strings)
    {
        return Err("Canvas key order must contain every object type.".into());
    }
    if !exact(&v["layout"], &["indent", "trailing_newline"])
        || !v["layout"]["indent"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.chars().all(|c| matches!(c, ' ' | '\t')))
        || !v["layout"]["trailing_newline"].is_boolean()
    {
        return Err("Canvas layout must name an indent and trailing newline choice.".into());
    }
    // JS has one numeric type: a mathematically whole JSON value such as
    // 1.0 is an integer there. Normalize validated artifact numbers before
    // deserializing Rust's integer fields, so the loaders agree.
    for key in ["format", "artifact_version"] {
        v[key] = Value::from(v[key].as_f64().unwrap() as u64);
    }
    for n in v["cerebro_versions"].as_array_mut().unwrap() {
        *n = Value::from(n.as_f64().unwrap() as u64);
    }
    for n in v["limits"].as_object_mut().unwrap().values_mut() {
        *n = Value::from(n.as_f64().unwrap() as u64);
    }
    serde_json::from_value(v)
        .map_err(|_| "Canvas format has missing, unknown or invalid fields.".into())
}

pub fn table() -> &'static CanvasFormat {
    static TABLE: OnceLock<CanvasFormat> = OnceLock::new();
    TABLE.get_or_init(|| parse(FORMAT_JSON).expect("the compiled canvas format validates"))
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
            crate::ledger::sha256_hex(FORMAT_JSON.as_bytes()),
            std::fs::read_to_string(repo(DIGEST_PATH)).unwrap().trim()
        );
        assert_eq!(
            FORMAT_JSON,
            std::fs::read_to_string(repo(FORMAT_PATH)).unwrap()
        );
    }
    #[test]
    #[ignore = "run explicitly after a deliberate canvas format edit"]
    fn write_canvas_digest() {
        std::fs::write(
            repo(DIGEST_PATH),
            format!("{}\n", crate::ledger::sha256_hex(FORMAT_JSON.as_bytes())),
        )
        .unwrap();
    }
    #[test]
    fn format_refusals_match_the_shared_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../shared/canvas/format-cases.json")).unwrap();
        for c in cases.as_array().unwrap() {
            let mut v: Value = serde_json::from_str(FORMAT_JSON).unwrap();
            let path = c["path"].as_array().unwrap();
            let mut at = &mut v;
            for key in &path[..path.len() - 1] {
                at = &mut at[key.as_str().unwrap()];
            }
            let key = path.last().unwrap().as_str().unwrap();
            if c.get("remove") == Some(&Value::Bool(true)) {
                at.as_object_mut().unwrap().remove(key);
            } else {
                at[key] = c["value"].clone();
            }
            assert_eq!(
                parse(&v.to_string()).unwrap_err(),
                c["message"].as_str().unwrap()
            );
        }
    }
}
