//! Persisted app configuration (last opened vault), stored as JSON in the
//! Tauri app-config directory.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub last_vault: Option<String>,
    /// **The proposal kill switch** (M26.3c). While this is false, the live
    /// loopback MCP server serves its twelve read/write tools and NO
    /// proposal tools at all — a model cannot call a mutation surface it
    /// cannot see.
    ///
    /// `bool` with `Default` = **false**, and that is the load-bearing part:
    /// an existing `config.json` written before this field existed, a
    /// corrupt one, a missing directory, and a fresh install all read as
    /// OFF. The failure modes of a config file all point the safe way, which
    /// is the only reason a config file is an acceptable home for a switch
    /// like this.
    ///
    /// M26.3c registers the tools and proves the gates; this is what M26.9
    /// flips. Registration is not activation.
    pub agent_proposals_enabled: bool,
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join(CONFIG_FILE)
}

/// Load the config from `<dir>/config.json`; any failure → default config.
pub fn load(dir: &Path) -> AppConfig {
    std::fs::read_to_string(config_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Write the config to `<dir>/config.json`, creating the directory.
pub fn save(dir: &Path, config: &AppConfig) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(dir), raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn load_returns_default_when_missing() {
        let dir = testutil::temp_vault("config-missing");
        assert_eq!(load(&dir), AppConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = testutil::temp_vault("config-roundtrip");
        let config = AppConfig {
            last_vault: Some("/Users/me/vault".to_string()),
            agent_proposals_enabled: false,
        };
        save(&dir, &config).unwrap();
        assert_eq!(load(&dir), config);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_json_falls_back_to_default() {
        let dir = testutil::temp_vault("config-corrupt");
        std::fs::write(dir.join("config.json"), "{not json").unwrap();
        assert_eq!(load(&dir), AppConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_serializes_last_vault_as_camel_case() {
        let raw = serde_json::to_string(&AppConfig {
            last_vault: Some("/v".into()),
            agent_proposals_enabled: false,
        })
        .unwrap();
        assert!(raw.contains("\"lastVault\""));
    }

    #[test]
    fn the_proposal_switch_is_off_unless_a_config_says_otherwise() {
        // EVERY failure path points the safe way, which is the only reason a
        // config file is an acceptable home for this switch: a missing
        // directory, a missing key, and unparseable JSON all read as OFF.
        let dir = testutil::temp_vault("config-proposal-switch");
        assert!(!load(&dir).agent_proposals_enabled, "missing file");

        save(
            &dir,
            &AppConfig {
                last_vault: None,
                agent_proposals_enabled: false,
            },
        )
        .unwrap();
        // A config written before this field existed.
        std::fs::write(dir.join("config.json"), r#"{"lastVault":"/v"}"#).unwrap();
        assert!(!load(&dir).agent_proposals_enabled, "older config");

        std::fs::write(dir.join("config.json"), "{not json").unwrap();
        assert!(!load(&dir).agent_proposals_enabled, "corrupt config");

        std::fs::write(dir.join("config.json"), r#"{"agentProposalsEnabled":true}"#).unwrap();
        assert!(load(&dir).agent_proposals_enabled, "explicitly on");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
