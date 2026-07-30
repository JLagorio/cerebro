//! Git tracking for the vault (M9.4).
//!
//! Ported from tolaria's `src-tauri/src/git/`, adapted to cerebro's vault
//! model. Two decisions carried over unchanged because they are earned:
//!
//! 1. **Shell out to `git`** rather than link libgit2 — no build-time C
//!    dependency, and no reimplementation of authentication.
//! 2. **Resolve the workspace first.** The vault directory is frequently not
//!    the repository root, and every command scopes through
//!    [`workspace::GitWorkspaceInfo`].
//!
//! Two adapted:
//!
//! - The WSL provider is dropped (macOS only), but `GitProviderStatus` keeps
//!   its shape so a Windows port is a branch, not a redesign.
//! - `ensure_gitignore` does NOT ignore `knowledge/`. The assistant writes
//!   there unattended; untracked writes cannot be reviewed or reverted, which
//!   is the whole argument for having git here.

pub mod author;
pub mod command;
pub mod commit;
pub mod conflict;
pub mod dates;
pub mod history;
pub mod provider;
pub mod pulse;
pub mod remote;
pub mod status;
pub mod workspace;

use std::path::Path;

use workspace::GitWorkspaceInfo;

/// Resolve the workspace for a vault path. Every command starts here.
pub fn workspace_for(vault: &str) -> GitWorkspaceInfo {
    workspace::resolve(Path::new(vault))
}

/// Clone a repository into a new directory.
pub fn clone_repo(url: &str, destination: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Enter a repository URL.".into());
    }
    if url.starts_with('-') {
        return Err("That does not look like a URL.".into());
    }
    // Same transport allow-list as add_remote: `ext::` and `file://` can run
    // commands on clone, which a notes app has no business doing.
    let allowed = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("ssh://")
        || url.starts_with("git@");
    if !allowed {
        return Err("Use an https:// or ssh repository URL.".into());
    }

    let dest = Path::new(destination);
    if dest.exists() && dest.read_dir().map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err("That folder already has something in it.".into());
    }
    let parent = dest.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    match command::run(parent, &["clone", url, destination]) {
        Ok(_) => Ok(destination.to_string()),
        Err(f) => Err(remote::classify(&f.stderr).1),
    }
}

/// A web URL for one file, when the remote is a recognizable forge.
///
/// Best-effort by design: an unrecognized host returns None and the UI simply
/// does not offer the link, rather than producing one that 404s.
pub fn file_url(ws: &GitWorkspaceInfo, vault_relative: &str) -> Option<String> {
    if !ws.is_repo() {
        return None;
    }
    let dir = ws.dir();
    let remote_url = command::run_str(&dir, &["remote", "get-url", "origin"])
        .ok()?
        .trim()
        .to_string();
    let base = web_base(&remote_url)?;
    let branch = command::run_str(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()?
        .trim()
        .to_string();
    let path = ws.to_git_relative(vault_relative);
    Some(format!("{base}/blob/{branch}/{path}"))
}

/// Normalize `git@host:owner/repo.git` and `https://host/owner/repo.git`
/// into `https://host/owner/repo`.
pub fn web_base(remote_url: &str) -> Option<String> {
    let url = remote_url.trim().trim_end_matches(".git");
    if let Some(rest) = url.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return Some(format!("https://{host}/{path}"));
    }
    if let Some(rest) = url.strip_prefix("ssh://git@") {
        return Some(format!("https://{rest}"));
    }
    if url.starts_with("https://") || url.starts_with("http://") {
        return Some(url.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_remote_urls_to_web_bases() {
        assert_eq!(
            web_base("git@github.com:acme/notes.git").as_deref(),
            Some("https://github.com/acme/notes")
        );
        assert_eq!(
            web_base("https://github.com/acme/notes.git").as_deref(),
            Some("https://github.com/acme/notes")
        );
        assert_eq!(
            web_base("ssh://git@gitlab.com/acme/notes.git").as_deref(),
            Some("https://gitlab.com/acme/notes")
        );
    }

    #[test]
    fn an_unrecognized_remote_yields_no_link() {
        assert!(web_base("/srv/mirrors/notes").is_none());
    }

    #[test]
    fn clone_rejects_transports_that_can_execute_commands() {
        assert!(clone_repo("ext::sh -c 'touch /tmp/pwned'", "/tmp/x").is_err());
        assert!(clone_repo("file:///tmp/evil", "/tmp/x").is_err());
        assert!(clone_repo("--upload-pack=evil", "/tmp/x").is_err());
    }
}
