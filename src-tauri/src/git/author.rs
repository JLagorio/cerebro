//! Commit identity.
//!
//! A vault created by the app may sit on a machine with no `user.name` set,
//! where every commit fails with a message about telling git who you are.
//! `ensure_identity` writes a repository-local fallback so the first
//! checkpoint works; `identity` reports what will actually be used and where
//! it came from, so Settings can show it rather than guess.

use serde::Serialize;
use std::path::Path;

use super::command;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IdentitySource {
    Repository,
    Global,
    System,
    Environment,
    Fallback,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAuthorIdentity {
    pub name: String,
    pub email: String,
    pub source: IdentitySource,
    /// Set when a repo-local identity shadows a global one — the commits you
    /// are about to make are not attributed the way the rest of your work is.
    pub warning: Option<String>,
}

pub const FALLBACK_NAME: &str = "Cerebro";
pub const FALLBACK_EMAIL: &str = "cerebro@localhost";

fn config_value(dir: &Path, scope: &str, key: &str) -> Option<String> {
    let out = command::run(dir, &["config", scope, "--get", key]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn resolved(dir: &Path, key: &str) -> Option<String> {
    let out = command::run(dir, &["config", "--get", key]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn identity(dir: &Path) -> GitAuthorIdentity {
    let name = resolved(dir, "user.name");
    let email = resolved(dir, "user.email");

    let local_name = config_value(dir, "--local", "user.name");
    let global_name = config_value(dir, "--global", "user.name");

    // Nothing resolves at all — the case that makes `git commit` fail with
    // "please tell me who you are".
    let unset = name.is_none() && email.is_none();

    let source = if unset {
        IdentitySource::Fallback
    } else if local_name.is_some() {
        IdentitySource::Repository
    } else if global_name.is_some() {
        IdentitySource::Global
    } else {
        IdentitySource::System
    };

    let warning = if local_name.is_some() && global_name.is_some() && local_name != global_name {
        Some("This repository overrides your global git identity.".to_string())
    } else {
        None
    };

    GitAuthorIdentity {
        name: name.unwrap_or_else(|| FALLBACK_NAME.to_string()),
        email: email.unwrap_or_else(|| FALLBACK_EMAIL.to_string()),
        source,
        warning,
    }
}

/// Write a repo-local identity only when none resolves. Never overwrites a
/// real one — the user's own name on their own commits is not ours to
/// replace.
pub fn ensure_identity(dir: &Path) -> Result<(), String> {
    if resolved(dir, "user.name").is_none() {
        command::run_str(dir, &["config", "--local", "user.name", FALLBACK_NAME])?;
    }
    if resolved(dir, "user.email").is_none() {
        command::run_str(dir, &["config", "--local", "user.email", FALLBACK_EMAIL])?;
    }
    Ok(())
}
