//! Can this workspace authenticate to its remote BEFORE we try? (M32.10)
//!
//! `remote::classify` diagnoses auth failure after the fact; for a mounted
//! work repo the user didn't configure through us, an answer up front is
//! the difference between a sync button that works and one that fails with
//! a good error. We ask git's own credential machinery and store nothing —
//! system git owns auth, and that posture is what removes credential storage
//! from the attack surface entirely.
//!
//! Two hardening properties, both load-bearing:
//! - `credential fill` runs from a NEUTRAL cwd, never inside the mounted
//!   repo. Git discovers a repo from cwd and honors its local config there
//!   — including a repo-declared `credential.helper`, which is arbitrary
//!   command execution ordered by a repo Cerebro does not own. From a
//!   non-repo cwd only the user's global/system helpers are consulted,
//!   which is exactly the question we are asking.
//! - A URL carrying control characters is never written into the
//!   credential protocol (the CVE-2020-5260 injection class: a config value
//!   with embedded newlines could smuggle extra `host=`/`password=` lines).

use serde::Serialize;

use super::command;
use super::workspace::GitWorkspaceInfo;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialReadiness {
    /// A helper answered with a credential for the remote's host.
    Ready,
    /// No remote configured — nothing to authenticate against.
    NoRemote,
    /// HTTPS remote and no helper produced a credential.
    NoHelper,
    /// SSH remote: we do not probe (an ssh connection attempt is observable
    /// by the server; a probe that phones home is not a probe). The UI treats
    /// this as "try and see".
    Unknown,
}

pub fn probe(ws: &GitWorkspaceInfo) -> CredentialReadiness {
    let dir = ws.dir();
    let url = match command::run_str(&dir, &["remote", "get-url", "origin"]) {
        Ok(u) => u.trim().to_string(),
        Err(_) => return CredentialReadiness::NoRemote,
    };
    if url.is_empty() {
        return CredentialReadiness::NoRemote;
    }
    if url.bytes().any(|b| b < 0x20) {
        // A config value can embed newlines via quoted escapes; refusing
        // control characters keeps the credential protocol un-smuggleable.
        return CredentialReadiness::Unknown;
    }
    if url.starts_with("git@") || url.starts_with("ssh://") {
        return CredentialReadiness::Unknown;
    }
    // `git credential fill` consults the configured helpers without touching
    // the network. Prompting is already disabled by `command::git_command`
    // (GIT_TERMINAL_PROMPT=0, empty ASKPASS), so a helperless setup fails fast
    // instead of hanging. NEUTRAL cwd — see the module doc; the repo's own
    // credential.helper must never run.
    let neutral = std::env::temp_dir();
    let mut child = match command::git_at(&neutral)
        .args(["credential", "fill"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return CredentialReadiness::Unknown,
    };
    use std::io::Write;
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = write!(stdin, "url={url}\n\n");
    }
    match child.wait_with_output() {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            if text.lines().any(|l| l.starts_with("password=")) {
                CredentialReadiness::Ready
            } else {
                CredentialReadiness::NoHelper
            }
        }
        _ => CredentialReadiness::NoHelper,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(label: &str) -> std::path::PathBuf {
        let dir = crate::vault::testutil::temp_vault(label);
        crate::git::commit::init_repo(&dir).unwrap();
        dir
    }

    // The `Ready` arm is deliberately untested: it would assert against
    // whatever helper this developer's machine happens to have configured.
    // The deterministic arms pin the shape.

    #[test]
    fn no_remote_probes_to_no_remote() {
        let dir = repo("m32-cred-none");
        let ws = crate::git::workspace::resolve(&dir);
        assert_eq!(probe(&ws), CredentialReadiness::NoRemote);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ssh_remotes_are_not_probed() {
        let dir = repo("m32-cred-ssh");
        let ws = crate::git::workspace::resolve(&dir);
        command::run_str(
            &ws.dir(),
            &["remote", "add", "origin", "git@github.com:x/y.git"],
        )
        .unwrap();
        assert_eq!(probe(&ws), CredentialReadiness::Unknown);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_url_with_control_characters_is_refused_not_probed() {
        let dir = repo("m32-cred-hostile");
        let ws = crate::git::workspace::resolve(&dir);
        // git config accepts quoted escapes; configure the decoded result
        // directly to simulate what a hostile .git/config would yield.
        command::run_str(
            &ws.dir(),
            &[
                "config",
                "remote.origin.url",
                "https://x.test/a\nhost=evil.test",
            ],
        )
        .unwrap();
        assert_eq!(probe(&ws), CredentialReadiness::Unknown);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
