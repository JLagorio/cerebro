//! Tracking-branch management (M32.10). `remote_status` reports
//! `has_upstream`; this is the write half — a mounted repo whose branch
//! tracks nothing cannot fetch/pull meaningfully, and "set it up" beats
//! "go run git commands yourself".

use super::command;
use super::workspace::GitWorkspaceInfo;

/// Point the current branch at `origin/<branch>`.
///
/// Fails typed-stringly (the caller wraps it) when the remote branch does not
/// exist — we do NOT create remote branches from here; that is push territory,
/// and push on a mounted work repo is a policy-layer milestone.
pub fn set_upstream_to_origin(ws: &GitWorkspaceInfo, branch: &str) -> Result<(), String> {
    command::run_str(
        &ws.dir(),
        &[
            "branch",
            &format!("--set-upstream-to=origin/{branch}"),
            branch,
        ],
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture needs a real commit: `--set-upstream-to` on an unborn
    /// branch fails for a DIFFERENT reason ("no commit on branch") and would
    /// pin the wrong failure. Identity is configured locally so the test does
    /// not depend on this machine's global git config, and the branch name is
    /// read back because the init default varies by configuration.
    #[test]
    fn upstream_to_a_missing_remote_branch_fails_naming_the_ref() {
        let dir = crate::vault::testutil::temp_vault("m32-upstream");
        crate::git::commit::init_repo(&dir).unwrap();
        let ws = crate::git::workspace::resolve(&dir);
        command::run_str(&ws.dir(), &["config", "user.email", "t@example.com"]).unwrap();
        command::run_str(&ws.dir(), &["config", "user.name", "t"]).unwrap();
        command::run_str(&ws.dir(), &["commit", "--allow-empty", "-m", "seed"]).unwrap();
        let branch = command::run_str(&ws.dir(), &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        let err = set_upstream_to_origin(&ws, &branch).unwrap_err();

        assert!(
            err.contains(&format!("origin/{branch}")),
            "the failure names the missing ref: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
