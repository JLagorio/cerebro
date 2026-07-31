//! Per-vault MCP connector config (M13.3).
//!
//! `<vault>/.cerebro/connectors.json` names the MCP servers the agent may
//! reach from THIS vault:
//!
//! ```json
//! {
//!   "servers": {
//!     "atlassian": { "transport": "http", "url": "https://…/mcp", "enabled": true },
//!     "linear":    { "transport": "stdio", "command": "npx",
//!                    "args": ["-y", "@linear/mcp"], "enabled": false }
//!   }
//! }
//! ```
//!
//! Before this file existed, connectors meant "omit --strict-mcp-config and
//! inherit whatever ~/.claude.json holds" — all or nothing, and invisible.
//! With a config present the run is STRICT again: exactly the enabled
//! servers, merged beside cerebro's own loopback. Cerebro still holds no
//! credentials — the entries here are the user's own, per vault, on disk
//! they control. A vault without the file keeps the legacy behavior so
//! nobody's working setup breaks.

use serde_json::{Map, Value};
use std::path::Path;

pub const CONFIG_PATH: &str = ".cerebro/connectors.json";

pub fn read_raw(vault: &Path) -> Option<String> {
    std::fs::read_to_string(vault.join(CONFIG_PATH)).ok()
}

pub fn save_raw(vault: &Path, json: &str) -> Result<(), String> {
    let parsed: Value =
        serde_json::from_str(json).map_err(|e| format!("connectors.json is not valid JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("connectors.json must be a JSON object".into());
    }
    let path = vault.join(CONFIG_PATH);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// The vault's enabled servers as `mcpServers` entries, plus whether the run
/// should be pinned to the merged config (`--strict-mcp-config`).
///
/// Three cases, fail-closed in the odd one:
/// - no config file + connectors on → legacy: nothing merged, strict OFF
///   (the CLI loads the user's own servers, pre-M13.3 behavior);
/// - config file + connectors on → the enabled entries, strict ON;
/// - unparseable config + connectors on → nothing merged, strict ON — a
///   broken explicit list must not silently widen into "everything".
pub fn connector_context(vault: &Path, connectors: bool) -> (Map<String, Value>, bool) {
    if !connectors {
        return (Map::new(), true);
    }
    match read_raw(vault) {
        None => (Map::new(), false),
        Some(raw) => match serde_json::from_str::<Value>(&raw) {
            Err(_) => (Map::new(), true),
            Ok(parsed) => (enabled_servers(&parsed), true),
        },
    }
}

fn enabled_servers(config: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(servers) = config.get("servers").and_then(|s| s.as_object()) else {
        return out;
    };
    for (name, spec) in servers {
        if spec.get("enabled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let mut entry = Map::new();
        match spec.get("transport").and_then(Value::as_str) {
            Some("http") => {
                let Some(url) = spec.get("url").and_then(Value::as_str) else {
                    continue;
                };
                entry.insert("type".into(), Value::String("http".into()));
                entry.insert("url".into(), Value::String(url.into()));
                if let Some(headers) = spec.get("headers").filter(|h| h.is_object()) {
                    entry.insert("headers".into(), headers.clone());
                }
            }
            Some("stdio") => {
                let Some(command) = spec.get("command").and_then(Value::as_str) else {
                    continue;
                };
                entry.insert("type".into(), Value::String("stdio".into()));
                entry.insert("command".into(), Value::String(command.into()));
                if let Some(args) = spec.get("args").filter(|a| a.is_array()) {
                    entry.insert("args".into(), args.clone());
                }
                if let Some(env) = spec.get("env").filter(|e| e.is_object()) {
                    entry.insert("env".into(), env.clone());
                }
            }
            _ => continue,
        }
        out.insert(name.clone(), Value::Object(entry));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_vault(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cerebro-connectors-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn no_config_keeps_the_legacy_open_mode() {
        let vault = temp_vault("legacy");
        let (servers, strict) = connector_context(&vault, true);
        assert!(servers.is_empty());
        assert!(!strict, "no explicit list yet: the user's own config still works");
    }

    #[test]
    fn connectors_off_is_always_strict_and_empty() {
        let vault = temp_vault("off");
        save_raw(
            &vault,
            &json!({"servers": {"a": {"transport": "http", "url": "https://x/mcp", "enabled": true}}})
                .to_string(),
        )
        .unwrap();
        let (servers, strict) = connector_context(&vault, false);
        assert!(servers.is_empty());
        assert!(strict);
    }

    #[test]
    fn a_config_makes_the_run_strict_with_exactly_the_enabled_servers() {
        let vault = temp_vault("explicit");
        save_raw(
            &vault,
            &json!({"servers": {
                "jira": {"transport": "http", "url": "https://jira/mcp", "enabled": true,
                          "headers": {"Authorization": "Bearer t"}},
                "linear": {"transport": "stdio", "command": "npx", "args": ["-y", "@linear/mcp"],
                            "env": {"KEY": "v"}, "enabled": true},
                "off": {"transport": "http", "url": "https://off/mcp", "enabled": false},
                "broken": {"transport": "http", "enabled": true}
            }})
            .to_string(),
        )
        .unwrap();
        let (servers, strict) = connector_context(&vault, true);
        assert!(strict, "an explicit list pins the run to it");
        assert_eq!(servers.len(), 2, "disabled and url-less entries stay out");
        assert_eq!(servers["jira"]["type"], "http");
        assert_eq!(servers["jira"]["headers"]["Authorization"], "Bearer t");
        assert_eq!(servers["linear"]["command"], "npx");
        assert_eq!(servers["linear"]["args"][1], "@linear/mcp");
    }

    #[test]
    fn a_broken_config_fails_closed_rather_than_open() {
        let vault = temp_vault("broken");
        std::fs::create_dir_all(vault.join(".cerebro")).unwrap();
        std::fs::write(vault.join(CONFIG_PATH), "{not json").unwrap();
        let (servers, strict) = connector_context(&vault, true);
        assert!(servers.is_empty());
        assert!(strict, "an unreadable explicit list must not widen into everything");
    }

    #[test]
    fn save_rejects_non_object_payloads() {
        let vault = temp_vault("save");
        assert!(save_raw(&vault, "[]").is_err());
        assert!(save_raw(&vault, "{not json").is_err());
        assert!(save_raw(&vault, "{\"servers\":{}}").is_ok());
        assert_eq!(read_raw(&vault).unwrap(), "{\"servers\":{}}");
    }
}
