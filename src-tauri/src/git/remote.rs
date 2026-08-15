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

/// `git fetch origin` — updates remote-tracking refs, touches nothing local.
///
/// The safe half of sync, and the half offered on mounted roots first: it can
/// change no file in a repository Cerebro does not own.
pub fn fetch(ws: &GitWorkspaceInfo) -> RemoteResult {
    if !has_remote(ws) {
        return RemoteResult::plain(RemoteOutcome::NoRemote, "No remote configured");
    }
    match command::run(&ws.dir(), &["fetch", "origin"]) {
        Ok(_) => RemoteResult::plain(RemoteOutcome::Updated, "Fetched"),
        Err(failure) => {
            let (status, message) = classify(&failure.stderr);
            RemoteResult::plain(status, message)
        }
    }
}

/// `git pull --ff-only`. A pull that would need a merge is REFUSED.
///
/// Cerebro never creates a conflict in a repository it does not own, so
/// divergence reports `Rejected` and the user resolves it in their own
/// tooling. This is deliberately NOT `pull()`, which retries as a real merge
/// to walk a VAULT owner to a resolvable conflict — the vault is ours to
/// make a mess in, a mounted work repo is not.
///
/// Judgment call, recorded: divergence maps to the existing
/// `RemoteOutcome::Rejected` rather than a new variant. The TS side matches on
/// a closed set of snake_case strings, and a new variant would ripple through
/// every consumer for one message's worth of nuance. Revisit only if the UI
/// needs to ACT differently on divergence than on push-rejection.
pub fn pull_ff(ws: &GitWorkspaceInfo) -> RemoteResult {
    if !has_remote(ws) {
        return RemoteResult::plain(RemoteOutcome::NoRemote, "No remote configured");
    }
    match command::run(&ws.dir(), &["pull", "--ff-only", "origin"]) {
        Ok(out) => {
            if out.contains("Already up to date") {
                RemoteResult::plain(RemoteOutcome::UpToDate, "Already up to date")
            } else {
                RemoteResult::plain(RemoteOutcome::Updated, "Fast-forwarded")
            }
        }
        Err(failure) => {
            let msg = failure.stderr.to_lowercase();
            if msg.contains("not possible to fast-forward")
                || msg.contains("diverging")
                || msg.contains("have diverged")
            {
                return RemoteResult::plain(
                    RemoteOutcome::Rejected,
                    "Local and remote have diverged; resolve outside Cerebro",
                );
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
    use crate::git::workspace;

    /// Identity local to the fixture, so a test never depends on (or is
    /// broken by) this machine's global git config.
    fn seed_identity(dir: &std::path::Path) {
        command::run_str(dir, &["config", "user.email", "t@example.com"]).unwrap();
        command::run_str(dir, &["config", "user.name", "t"]).unwrap();
    }

    /// An upstream and a clone that have each gained a commit — the state
    /// `--ff-only` must refuse.
    ///
    /// Built entirely through the crate's env-scrubbed helpers: `temp_vault`
    /// for scratch dirs (there are no `[dev-dependencies]` here, so no
    /// `tempfile`), `init_repo` + `run_str` for git. A bare
    /// `Command::new("git")` is banned in this crate — command.rs's
    /// `REPO_SELECTING_VARS` comment records what raw test git under a
    /// hook-exported `GIT_DIR` did to this checkout, three times.
    ///
    /// The clone is by FILESYSTEM PATH, not a `file://` URL: M32.10 pins
    /// `protocol.file.allow=user`, which permits direct user-context use.
    fn diverged_fixture(label: &str) -> workspace::GitWorkspaceInfo {
        let upstream = crate::vault::testutil::temp_vault(&format!("{label}-upstream"));
        crate::git::commit::init_repo(&upstream).unwrap();
        seed_identity(&upstream);
        command::run_str(&upstream, &["commit", "--allow-empty", "-m", "base"]).unwrap();

        let parent = crate::vault::testutil::temp_vault(&format!("{label}-parent"));
        let clone_dir = parent.join("clone");
        command::run_str(
            &parent,
            &[
                "clone",
                upstream.to_str().unwrap(),
                clone_dir.to_str().unwrap(),
            ],
        )
        .unwrap();
        seed_identity(&clone_dir);

        // One more commit on each side: neither is an ancestor of the other.
        command::run_str(
            &upstream,
            &["commit", "--allow-empty", "-m", "upstream-only"],
        )
        .unwrap();
        command::run_str(&clone_dir, &["commit", "--allow-empty", "-m", "local-only"]).unwrap();

        workspace::resolve(&clone_dir)
    }

    #[test]
    fn fetch_with_no_remote_is_no_remote_not_error() {
        let dir = crate::vault::testutil::temp_vault("m32-fetch-none");
        crate::git::commit::init_repo(&dir).unwrap();
        let ws = workspace::resolve(&dir);
        assert_eq!(fetch(&ws).status, RemoteOutcome::NoRemote);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_diverged_pull_ff_reports_rejected_and_changes_nothing() {
        let ws = diverged_fixture("m32-diverged");
        let before = command::run_str(&ws.dir(), &["rev-parse", "HEAD"]).unwrap();

        let result = pull_ff(&ws);

        assert_eq!(result.status, RemoteOutcome::Rejected);
        let after = command::run_str(&ws.dir(), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(before, after, "a refused fast-forward must not move HEAD");
    }

    #[test]
    fn fetch_updates_tracking_refs_without_touching_the_working_tree() {
        let ws = diverged_fixture("m32-fetch-diverged");
        let before = command::run_str(&ws.dir(), &["rev-parse", "HEAD"]).unwrap();

        assert_eq!(fetch(&ws).status, RemoteOutcome::Updated);

        let after = command::run_str(&ws.dir(), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(before, after, "fetch must never move HEAD");
    }

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
