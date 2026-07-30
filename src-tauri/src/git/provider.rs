//! Is git usable on this machine?
//!
//! Tolaria probes native git AND every WSL distribution because it ships on
//! Windows. Cerebro is macOS-only, so this is a native-only probe that keeps
//! the same reported shape — `distributions` is always empty. Adding Windows
//! later means filling in a branch rather than reshaping the API and every
//! caller that reads it.

use serde::Serialize;

use super::command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProviderProbe {
    pub provider: String,
    pub label: String,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProviderStatus {
    pub selected_provider: String,
    pub native: GitProviderProbe,
    /// Always empty on macOS; present so the shape survives a Windows port.
    pub distributions: Vec<GitProviderProbe>,
}

fn which_git() -> Option<String> {
    let out = std::process::Command::new("which").arg("git").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

pub fn probe() -> GitProviderStatus {
    let version = command::git_version();
    let available = version.is_some();
    GitProviderStatus {
        selected_provider: "native".to_string(),
        native: GitProviderProbe {
            provider: "native".to_string(),
            label: "System git".to_string(),
            available,
            path: which_git(),
            message: if available {
                "Ready.".to_string()
            } else {
                // Actionable, because on a fresh Mac this is the actual fix.
                "git was not found. Install the Xcode command line tools with `xcode-select --install`."
                    .to_string()
            },
            version,
        },
        distributions: vec![],
    }
}
