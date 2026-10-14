//! Persisted app configuration (the last opened vault, the proposal switch,
//! and who answers in each vault's assistant panel), stored as JSON in the
//! Tauri app-config directory — and where that directory is (`app_dir`).

use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::BTreeMap;
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
    /// loopback MCP server serves only the tool manifest's base rows and NO
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
    /// **Who answers in the assistant panel** (M56.6, AI-8): vault path, as
    /// `last_vault` spells it, to the handle of the Agent record a panel turn
    /// goes to. Here and never in a vault file, so a vault can never choose
    /// who the panel answers as. A vault with no key answers as the plain
    /// assistant, and so does every config written before this field.
    pub panel_agents: BTreeMap<String, String>,
}

/// The longest handle a binding takes, in characters.
const HANDLE_MAX: usize = 64;

/// The slug grammar a handle has (M56.6): lowercase ASCII letters and digits
/// in runs joined by single dashes, at most [`HANDLE_MAX`] characters — what
/// the app's `slugify` makes of a title or a `slug:`.
fn is_handle(value: &str) -> bool {
    value.len() <= HANDLE_MAX
        && value.split('-').all(|run| {
            !run.is_empty()
                && run
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// The refusal for a value that is not a handle, in the words the browser
/// mock gives (`src/lib/mockIpc.ts`). The value is cut at 64 characters.
fn not_a_handle(value: &str) -> String {
    let shown: String = value.chars().take(HANDLE_MAX).collect();
    let cut = if value.chars().count() > HANDLE_MAX {
        "…"
    } else {
        ""
    };
    format!("\"{shown}{cut}\" is not an agent handle")
}

/// The handle this vault's panel is bound to, or None when it answers as the
/// plain assistant.
pub fn panel_agent(dir: &Path, vault: &str) -> Option<String> {
    load(dir).panel_agents.get(vault).cloned()
}

/// Bind this vault's panel to an agent handle, or unbind it with None or a
/// blank. A value outside the slug grammar is refused and nothing is written.
pub fn set_panel_agent(dir: &Path, vault: &str, handle: Option<&str>) -> Result<(), String> {
    let handle = handle.map(str::trim).filter(|h| !h.is_empty());
    if let Some(h) = handle {
        if !is_handle(h) {
            return Err(not_a_handle(h));
        }
    }
    let mut config = load(dir);
    match handle {
        Some(h) => {
            config.panel_agents.insert(vault.to_string(), h.to_string());
        }
        None => {
            config.panel_agents.remove(vault);
        }
    }
    save(dir, &config)
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

    /// Everything that reads the app directory goes through `app_dir`
    /// (M53.2). In a dev build the bundle's own config directory is the
    /// installed app's: M32.8's root git commands asked tauri for it
    /// directly, so re-landed on M49.2's split they read the installed app's
    /// `roots.json` and refused every root the dev build mounted with
    /// `no_such_root`. Only this file may ask.
    #[test]
    fn nothing_but_app_dir_asks_tauri_for_the_config_directory() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let this_file = src.join("app_config.rs");
        let mut scanned = 0;
        let mut offenders = Vec::new();
        for entry in walkdir::WalkDir::new(&src)
            .into_iter()
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path == this_file || path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            scanned += 1;
            let Ok(source) = std::fs::read_to_string(path) else {
                continue;
            };
            if source.contains("app_config_dir(") {
                offenders.push(path.display().to_string());
            }
        }
        assert!(scanned > 50, "the scan is walking the real tree");
        assert!(
            offenders.is_empty(),
            "call app_config::app_dir instead of app_config_dir(): {offenders:?}"
        );
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
            panel_agents: BTreeMap::from([("/Users/me/vault".to_string(), "scout".to_string())]),
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
            panel_agents: BTreeMap::new(),
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
                panel_agents: BTreeMap::new(),
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
    #[test]
    fn a_panel_binding_round_trips_per_vault() {
        let dir = testutil::temp_vault("config-panel-binding");
        set_panel_agent(&dir, "/vaults/a", Some("release-scout")).unwrap();
        set_panel_agent(&dir, "/vaults/b", Some("digest2")).unwrap();
        assert_eq!(
            panel_agent(&dir, "/vaults/a").as_deref(),
            Some("release-scout")
        );
        assert_eq!(panel_agent(&dir, "/vaults/b").as_deref(), Some("digest2"));
        assert_eq!(panel_agent(&dir, "/vaults/c"), None, "an unbound vault");
        let raw = std::fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(raw.contains("\"panelAgents\""), "{raw}");
        // Binding one vault keeps what else the config holds.
        let mut config = load(&dir);
        config.last_vault = Some("/vaults/a".into());
        save(&dir, &config).unwrap();
        set_panel_agent(&dir, "/vaults/a", Some(" scout ")).unwrap();
        let config = load(&dir);
        assert_eq!(config.last_vault.as_deref(), Some("/vaults/a"));
        assert_eq!(
            config.panel_agents.get("/vaults/a").map(String::as_str),
            Some("scout")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_config_reads_no_binding() {
        let dir = testutil::temp_vault("config-panel-older");
        std::fs::write(
            dir.join("config.json"),
            r#"{"lastVault":"/v","agentProposalsEnabled":true}"#,
        )
        .unwrap();
        let config = load(&dir);
        assert!(config.panel_agents.is_empty());
        assert!(config.agent_proposals_enabled, "the rest still reads");
        assert_eq!(panel_agent(&dir, "/v"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_handle_is_refused_and_nothing_is_written() {
        let dir = testutil::temp_vault("config-panel-malformed");
        set_panel_agent(&dir, "/v", Some("scout")).unwrap();
        let before = std::fs::read(dir.join("config.json")).unwrap();
        let long = "a".repeat(65);
        for bad in [
            "Scout",
            "release scout",
            "release--scout",
            "-scout",
            "scout-",
            "scout_2",
            "@scout",
            "scöut",
            "../scout",
            long.as_str(),
        ] {
            let refused = set_panel_agent(&dir, "/v", Some(bad)).unwrap_err();
            assert!(
                refused.ends_with("\" is not an agent handle"),
                "{bad}: {refused}"
            );
            assert_eq!(
                std::fs::read(dir.join("config.json")).unwrap(),
                before,
                "{bad}"
            );
        }
        assert_eq!(
            set_panel_agent(&dir, "/v", Some("Release Scout")).unwrap_err(),
            "\"Release Scout\" is not an agent handle"
        );
        assert_eq!(
            set_panel_agent(&dir, "/v", Some(&long)).unwrap_err(),
            format!("\"{}…\" is not an agent handle", "a".repeat(64))
        );
        // 64 is the limit, not past it.
        set_panel_agent(&dir, "/v", Some(&"a".repeat(64))).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_a_binding_removes_its_key() {
        let dir = testutil::temp_vault("config-panel-clear");
        set_panel_agent(&dir, "/a", Some("scout")).unwrap();
        set_panel_agent(&dir, "/b", Some("digest")).unwrap();
        set_panel_agent(&dir, "/a", None).unwrap();
        assert_eq!(panel_agent(&dir, "/a"), None);
        set_panel_agent(&dir, "/b", Some("  ")).unwrap();
        assert_eq!(panel_agent(&dir, "/b"), None, "a blank clears too");
        let raw = std::fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(!raw.contains("scout") && !raw.contains("digest"), "{raw}");
        // Clearing a vault that was never bound is not an error.
        set_panel_agent(&dir, "/never", None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
