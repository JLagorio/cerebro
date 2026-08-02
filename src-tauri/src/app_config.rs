//! Persisted app configuration (last opened vault), stored as JSON in the
//! Tauri app-config directory.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub last_vault: Option<String>,
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
        })
        .unwrap();
        assert!(raw.contains("\"lastVault\""));
    }
}
