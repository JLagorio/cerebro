//! Remotes: status, pull, push, and connecting one.
//!
//! Every network call here runs through `command::git_command`, which
//! disables prompting. That turns "hangs forever waiting on a TTY that does
//! not exist" into a fast failure — and `classify` below is the other half:
//! a suppressed prompt without classification is just an unexplained error.

use serde::Serialize;

use super::command;
use super::history::safe_rev;
use super::workspace::GitWorkspaceInfo;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteStatus {
    pub branch: String,
    pub ahead: usize,
    pub behind: usize,
    pub has_remote: bool,
    pub has_upstream: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteOutcome {
    Ok,
    UpToDate,
    Updated,
    Conflict,
    Rejected,
    AuthError,
    NetworkError,
    NoRemote,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteResult {
    pub status: RemoteOutcome,
    pub message: String,
    pub updated_files: Vec<String>,
    pub conflict_files: Vec<String>,
}

impl RemoteResult {
    fn plain(status: RemoteOutcome, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            updated_files: vec![],
            conflict_files: vec![],
        }
    }
}

pub fn has_remote(ws: &GitWorkspaceInfo) -> bool {
    if !ws.is_repo() {
        return false;
    }
    command::run_str(&ws.dir(), &["remote"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// Read the failure git actually reported and say what kind it is.
///
/// The distinction matters to the user: an auth error means "fix your
/// credentials", a network error means "try again", and a rejection means
/// "pull first". Collapsing them into one message makes all three unfixable.
pub fn classify(stderr: &str) -> (RemoteOutcome, String) {
    let lower = stderr.to_lowercase();
    let trimmed = stderr.trim().to_string();

    if lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("authentication failed")
        || lower.contains("permission denied")
        || lower.contains("terminal prompts disabled")
        || lower.contains("invalid username or password")
    {
        return (
            RemoteOutcome::AuthError,
            "Git could not authenticate with the remote. Check your credential helper or SSH key."
                .to_string(),
        );
    }
    if lower.contains("could not resolve host")
        || lower.contains("connection timed out")
        || lower.contains("network is unreachable")
        || lower.contains("connection refused")
        || lower.contains("operation timed out")
    {
        return (
            RemoteOutcome::NetworkError,
            "Could not reach the remote. Check your connection.".to_string(),
        );
    }
    if lower.contains("rejected") || lower.contains("non-fast-forward") {
        return (
            RemoteOutcome::Rejected,
            "The remote has commits you don't. Pull before pushing.".to_string(),
        );
    }
    if lower.contains("conflict") {
        return (RemoteOutcome::Conflict, trimmed);
    }
    (
        RemoteOutcome::Error,
        if trimmed.is_empty() {
            "git failed".to_string()
        } else {
            trimmed
        },
    )
}

pub fn remote_status(ws: &GitWorkspaceInfo) -> Result<GitRemoteStatus, String> {
    if !ws.is_repo() {
        return Ok(GitRemoteStatus {
            branch: String::new(),
            ahead: 0,
            behind: 0,
            has_remote: false,
            has_upstream: false,
            upstream: None,
        });
    }
    let dir = ws.dir();
    let branch = command::run_str(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let has_remote = has_remote(ws);
    let upstream = command::run_str(&dir, &["rev-parse", "--abbrev-ref", "@{upstream}"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let (ahead, behind) = match &upstream {
        None => (0, 0),
        Some(_) => command::run_str(
            &dir,
            &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        )
        .ok()
        .and_then(|out| {
            let mut parts = out.split_whitespace();
            let behind = parts.next()?.parse().ok()?;
            let ahead = parts.next()?.parse().ok()?;
            Some((ahead, behind))
        })
        .unwrap_or((0, 0)),
    };

    Ok(GitRemoteStatus {
        branch,
        ahead,
        behind,
        has_remote,
        has_upstream: upstream.is_some(),
        upstream,
    })
}

/// Files git reports as conflicted right now.
pub fn conflict_files(ws: &GitWorkspaceInfo) -> Vec<String> {
    if !ws.is_repo() {
        return vec![];
    }
    command::run_str(&ws.dir(), &["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| ws.to_vault_relative(l.trim()))
        .filter(|l| !l.is_empty())
        .collect()
}

pub fn pull(ws: &GitWorkspaceInfo) -> RemoteResult {
    if !ws.is_repo() {
        return RemoteResult::plain(
            RemoteOutcome::NoRemote,
            "This vault is not a git repository.",
        );
    }
    if !has_remote(ws) {
        return RemoteResult::plain(RemoteOutcome::NoRemote, "No remote is configured.");
    }
    let dir = ws.dir();
    let before = command::run_str(&dir, &["rev-parse", "HEAD"]).unwrap_or_default();

    match command::run(&dir, &["pull", "--ff-only"]) {
        Ok(out) => {
            let after = command::run_str(&dir, &["rev-parse", "HEAD"]).unwrap_or_default();
            if before.trim() == after.trim() {
                return RemoteResult::plain(RemoteOutcome::UpToDate, "Already up to date.");
            }
            let range = format!("{}..{}", before.trim(), after.trim());
            let updated = command::run_str(&dir, &["diff", "--name-only", &range])
                .unwrap_or_default()
                .lines()
                .filter_map(|l| ws.to_vault_relative(l.trim()))
                .collect();
            RemoteResult {
                status: RemoteOutcome::Updated,
                message: out.trim().to_string(),
                updated_files: updated,
                conflict_files: vec![],
            }
        }
        Err(failure) => {
            // --ff-only refuses rather than merging when histories diverged.
            // Retry as a real merge so the user reaches a resolvable conflict
            // instead of a dead end.
            let diverged = failure
                .stderr
                .to_lowercase()
                .contains("not possible to fast-forward")
                || failure.stderr.to_lowercase().contains("diverging");
            if diverged {
                return match command::run(&dir, &["pull", "--no-rebase"]) {
                    Ok(out) => RemoteResult {
                        status: RemoteOutcome::Updated,
                        message: out.trim().to_string(),
                        updated_files: vec![],
                        conflict_files: vec![],
                    },
                    Err(merge_failure) => {
                        let conflicts = conflict_files(ws);
                        if conflicts.is_empty() {
                            let (status, message) = classify(&merge_failure.stderr);
                            RemoteResult::plain(status, message)
                        } else {
                            RemoteResult {
                                status: RemoteOutcome::Conflict,
                                message: format!(
                                    "{} file{} conflict and need resolving.",
                                    conflicts.len(),
                                    if conflicts.len() == 1 { "" } else { "s" }
                                ),
                                updated_files: vec![],
                                conflict_files: conflicts,
                            }
                        }
                    }
                };
            }
            let (status, message) = classify(&failure.stderr);
            RemoteResult::plain(status, message)
        }
    }
}

pub fn push(ws: &GitWorkspaceInfo) -> RemoteResult {
    if !ws.is_repo() {
        return RemoteResult::plain(
            RemoteOutcome::NoRemote,
            "This vault is not a git repository.",
        );
    }
    if !has_remote(ws) {
        return RemoteResult::plain(RemoteOutcome::NoRemote, "No remote is configured.");
    }
    let dir = ws.dir();
    let status = remote_status(ws).unwrap_or(GitRemoteStatus {
        branch: String::new(),
        ahead: 0,
        behind: 0,
        has_remote: true,
        has_upstream: false,
        upstream: None,
    });

    // First push of a branch needs -u; after that the plain form is correct.
    // An empty branch name (detached HEAD) also gets the plain form — there
    // is no name to bind an upstream to.
    let args: Vec<&str> = if status.has_upstream || status.branch.is_empty() {
        vec!["push"]
    } else {
        vec!["push", "-u", "origin", status.branch.as_str()]
    };

    match command::run(&dir, &args) {
        Ok(out) => RemoteResult::plain(RemoteOutcome::Ok, out.trim().to_string()),
        Err(failure) => {
            let (status, message) = classify(&failure.stderr);
            RemoteResult::plain(status, message)
        }
    }
}

/// Point the vault at a remote. Refuses to silently replace an existing one.
pub fn add_remote(ws: &GitWorkspaceInfo, url: &str) -> RemoteResult {
    if !ws.is_repo() {
        return RemoteResult::plain(RemoteOutcome::Error, "This vault is not a git repository.");
    }
    let url = url.trim();
    if url.is_empty() {
        return RemoteResult::plain(RemoteOutcome::Error, "Enter a remote URL.");
    }
    if url.starts_with('-') {
        return RemoteResult::plain(RemoteOutcome::Error, "That does not look like a URL.");
    }
    // Only the transports a notes app should be reaching. `ext::` and
    // `file://` in particular can execute commands on clone.
    let allowed = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("ssh://")
        || url.starts_with("git@");
    if !allowed {
        return RemoteResult::plain(RemoteOutcome::Error, "Use an https:// or ssh remote URL.");
    }

    let dir = ws.dir();
    if has_remote(ws) {
        return RemoteResult::plain(
            RemoteOutcome::Error,
            "A remote is already configured. Disconnect it first.",
        );
    }
    match command::run(&dir, &["remote", "add", "origin", url]) {
        Ok(_) => RemoteResult::plain(RemoteOutcome::Ok, "Remote connected."),
        Err(f) => {
            let (status, message) = classify(&f.stderr);
            RemoteResult::plain(status, message)
        }
    }
}

pub fn disconnect_remotes(ws: &GitWorkspaceInfo) -> Result<(), String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    let dir = ws.dir();
    let names = command::run_str(&dir, &["remote"])?;
    for name in names.lines().map(str::trim).filter(|n| !n.is_empty()) {
        let safe = safe_rev(name)?;
        command::run_str(&dir, &["remote", "remove", &safe])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_failures_are_named_as_such() {
        for stderr in [
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "fatal: Authentication failed for 'https://x/'",
            "git@github.com: Permission denied (publickey).",
        ] {
            assert_eq!(classify(stderr).0, RemoteOutcome::AuthError, "{stderr}");
        }
    }

    #[test]
    fn network_failures_are_distinguished_from_auth() {
        assert_eq!(
            classify("fatal: unable to access: Could not resolve host: github.com").0,
            RemoteOutcome::NetworkError
        );
    }

    #[test]
    fn a_rejected_push_says_to_pull() {
        let (status, message) = classify("! [rejected] main -> main (non-fast-forward)");
        assert_eq!(status, RemoteOutcome::Rejected);
        assert!(message.contains("Pull"));
    }

    #[test]
    fn unknown_failures_keep_gits_own_words() {
        let (status, message) = classify("fatal: some unforeseen thing");
        assert_eq!(status, RemoteOutcome::Error);
        assert!(message.contains("unforeseen"));
    }
}
