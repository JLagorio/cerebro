//! Persisted app configuration (last opened vault), stored as JSON in the
//! Tauri app-config directory — and where that directory is (`app_dir`).

use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::path::{Path, PathBuf};

/// Set to opt a dev build back into the installed app's shared data
/// directory. Deliberate and loud: the default is isolation.
pub const SHARED_APP_DATA_ENV: &str = "CEREBRO_SHARED_APP_DATA";

/// This build's app-data directory (M49.2, K3): `config.json` (lastVault),
/// `runtime.db`, the ledger writer id and index. A release build uses the
/// bundle's `app_config_dir`. A DEV build gets `dev/<checkout>` beneath it,
/// keyed to the checkout it was compiled from: on 2026-08-17 a worktree dev
/// build shared `com.cerebro.app` with the installed app, auto-opened the
/// live vault under the same writer id, and rewrote concepts with an older
/// schema. Isolated, a dev build starts with no last vault, and a ledger
/// another build minted classifies as a foreign writer's rather than its own.
pub fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let shared = std::env::var_os(SHARED_APP_DATA_ENV).is_some_and(|v| v == "1");
    Ok(scoped(base, cfg!(debug_assertions), shared))
}

fn scoped(base: PathBuf, dev: bool, shared: bool) -> PathBuf {
    if dev && !shared {
        base.join("dev").join(checkout_key())
    } else {
        base
    }
}

/// `<checkout folder>-<12 hex of its path>`: readable in Finder, distinct
/// per worktree even when two share a folder name.
pub fn checkout_key() -> String {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let checkout = manifest.parent().unwrap_or(manifest);
    let name = checkout
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("checkout");
    let digest = sha2::Sha256::digest(checkout.to_string_lossy().as_bytes());
    let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("{name}-{hex}")
}

/// The build a process is, as the ledger lock records its holder (M49.2): a
/// release names its version, a dev build the checkout it came from.
pub fn build_label() -> String {
    let version = env!("CARGO_PKG_VERSION");
    if cfg!(debug_assertions) {
        format!("dev {version} from {}", checkout_key())
    } else {
        format!("Cerebro {version}")
    }
}

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
    fn a_dev_build_is_isolated_per_checkout_unless_it_opts_into_sharing() {
        let base = PathBuf::from("/app/com.cerebro.app");
        assert_eq!(
            scoped(base.clone(), false, false),
            base,
            "release: the bundle dir"
        );
        assert_eq!(scoped(base.clone(), false, true), base);
        assert_eq!(
            scoped(base.clone(), true, true),
            base,
            "dev, opted in: shared"
        );
        let isolated = scoped(base.clone(), true, false);
        assert_eq!(isolated, base.join("dev").join(checkout_key()));
        let key = checkout_key();
        let (name, hex) = key.rsplit_once('-').unwrap();
        assert!(!name.is_empty());
        assert_eq!(hex.len(), 12);
        assert!(build_label().contains(env!("CARGO_PKG_VERSION")));
    }

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
