//! Where the repository actually is.
//!
//! The vault directory is frequently NOT the git root — a vault checked out
//! inside a larger repo, or a repo whose root is a parent directory. Every
//! other call in this module scopes its pathspec through what this resolves.
//!
//! Skipping this produces an app that works on the developer's machine and
//! silently reports the wrong files on anyone else's, which is why it is the
//! first thing ported.

use serde::Serialize;
use std::path::{Path, PathBuf};

use super::command;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitRootRelation {
    /// The vault directory is itself the repository root.
    Vault,
    /// The repository root is an ancestor of the vault.
    Parent,
    /// Not a repository.
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceInfo {
    pub vault_root: String,
    pub git_root: Option<String>,
    /// Path prefix every command must scope to, relative to the git root.
    /// `None` when the vault IS the root — no scoping needed.
    pub vault_pathspec: Option<String>,
    pub git_root_relation: GitRootRelation,
    pub resolution_failure: Option<String>,
}

impl GitWorkspaceInfo {
    /// The directory git commands run in.
    pub fn dir(&self) -> PathBuf {
        match &self.git_root {
            Some(root) => PathBuf::from(root),
            None => PathBuf::from(&self.vault_root),
        }
    }

    pub fn is_repo(&self) -> bool {
        self.git_root.is_some()
    }

    /// Scope arguments for a command that should only see the vault's files.
    /// Empty when the vault is the root.
    pub fn pathspec_args(&self) -> Vec<String> {
        match &self.vault_pathspec {
            Some(prefix) => vec!["--".to_string(), format!("{prefix}/")],
            None => vec![],
        }
    }

    /// Turn a git-root-relative path into a vault-relative one, or None when
    /// the file lives outside the vault.
    pub fn to_vault_relative(&self, git_relative: &str) -> Option<String> {
        match &self.vault_pathspec {
            None => Some(git_relative.to_string()),
            Some(prefix) => git_relative
                .strip_prefix(&format!("{prefix}/"))
                .map(|s| s.to_string()),
        }
    }

    /// Turn a vault-relative path into a git-root-relative one.
    pub fn to_git_relative(&self, vault_relative: &str) -> String {
        match &self.vault_pathspec {
            None => vault_relative.to_string(),
            Some(prefix) => format!("{prefix}/{vault_relative}"),
        }
    }
}

fn not_a_repo(vault_root: &str, failure: Option<String>) -> GitWorkspaceInfo {
    GitWorkspaceInfo {
        vault_root: vault_root.to_string(),
        git_root: None,
        vault_pathspec: None,
        git_root_relation: GitRootRelation::None,
        resolution_failure: failure,
    }
}

pub fn resolve(vault_root: impl AsRef<Path>) -> GitWorkspaceInfo {
    let vault = vault_root.as_ref();
    let Some(vault_str) = vault.to_str() else {
        return not_a_repo("", Some("the vault path is not valid UTF-8".into()));
    };
    let vault_str = vault_str.to_owned();

    if !vault.is_dir() {
        return not_a_repo(&vault_str, Some("vault directory does not exist".into()));
    }

    let toplevel = match command::run(vault, &["rev-parse", "--show-toplevel"]) {
        Ok(out) => out.trim().to_string(),
        // Not a repository is the common case, not an error worth surfacing.
        Err(_) => return not_a_repo(&vault_str, None),
    };
    if toplevel.is_empty() {
        return not_a_repo(&vault_str, None);
    }

    // Canonicalize both sides before comparing: /var vs /private/var on macOS
    // would otherwise read as "vault inside a parent repo" for every vault in
    // a temp directory.
    let canonical_vault = vault.canonicalize().unwrap_or_else(|_| vault.to_path_buf());
    let canonical_root = Path::new(&toplevel)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&toplevel));

    if canonical_vault.to_str().is_none() || canonical_root.to_str().is_none() {
        return not_a_repo(
            &vault_str,
            Some("the repository path is not valid UTF-8".into()),
        );
    }

    if canonical_vault == canonical_root {
        return GitWorkspaceInfo {
            vault_root: vault_str,
            git_root: Some(canonical_root.to_string_lossy().to_string()),
            vault_pathspec: None,
            git_root_relation: GitRootRelation::Vault,
            resolution_failure: None,
        };
    }

    match canonical_vault.strip_prefix(&canonical_root) {
        Ok(rel) => {
            // Join actual components: on Unix a backslash is part of the
            // folder name, never a separator pointing at another sibling.
            let prefix = rel
                .iter()
                .map(|part| part.to_str().expect("canonical UTF-8 path"))
                .collect::<Vec<_>>()
                .join("/");
            GitWorkspaceInfo {
                vault_root: vault_str,
                git_root: Some(canonical_root.to_string_lossy().to_string()),
                vault_pathspec: if prefix.is_empty() {
                    None
                } else {
                    Some(prefix)
                },
                git_root_relation: GitRootRelation::Parent,
                resolution_failure: None,
            }
        }
        // git reported a toplevel that does not contain the vault. Refuse
        // rather than guess — operating on the wrong tree is worse than
        // reporting no history.
        Err(_) => not_a_repo(
            &vault_str,
            Some("git reported a repository root outside the vault".into()),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_backslash_in_a_vault_name_never_selects_a_sibling_folder() {
        let dir = super::super::commit::tests::scratch_repo_dir("workspace-backslash");
        std::fs::create_dir_all(dir.join("vault\\notes")).unwrap();
        std::fs::create_dir_all(dir.join("vault/notes")).unwrap();
        command::run_str(&dir, &["init"]).unwrap();
        super::super::commit::tests::assert_isolated(&dir);
        let ws = resolve(dir.join("vault\\notes"));
        assert_eq!(ws.vault_pathspec.as_deref(), Some("vault\\notes"));
        std::fs::write(dir.join("vault\\notes/a.md"), "vault").unwrap();
        std::fs::write(dir.join("vault/notes/outside.md"), "outside").unwrap();
        command::run_str(&dir, &["add", "--", "vault/notes/outside.md"]).unwrap();
        super::super::commit::commit_all(&ws, "literal directory")
            .unwrap()
            .unwrap();
        assert!(command::succeeds(
            &dir,
            &["cat-file", "-e", "HEAD:vault\\notes/a.md"]
        ));
        assert!(!command::succeeds(
            &dir,
            &["cat-file", "-e", "HEAD:vault/notes/outside.md"]
        ));
        assert_eq!(
            command::run_str(&dir, &["show", ":vault/notes/outside.md"]).unwrap(),
            "outside"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_vault_path_refuses_before_git_resolution() {
        use std::os::unix::ffi::OsStringExt;
        let path = PathBuf::from(std::ffi::OsString::from_vec(b"vault-\xff".to_vec()));
        let ws = resolve(path);
        assert!(!ws.is_repo());
        assert_eq!(
            ws.resolution_failure.as_deref(),
            Some("the vault path is not valid UTF-8")
        );
    }

    #[test]
    fn missing_directory_is_not_a_repo() {
        let info = resolve("/definitely/not/here");
        assert!(!info.is_repo());
        assert_eq!(info.git_root_relation, GitRootRelation::None);
    }

    #[test]
    fn pathspec_args_are_empty_at_the_root() {
        let info = GitWorkspaceInfo {
            vault_root: "/v".into(),
            git_root: Some("/v".into()),
            vault_pathspec: None,
            git_root_relation: GitRootRelation::Vault,
            resolution_failure: None,
        };
        assert!(info.pathspec_args().is_empty());
        assert_eq!(info.to_git_relative("a.md"), "a.md");
        assert_eq!(info.to_vault_relative("a.md"), Some("a.md".into()));
    }

    #[test]
    fn nested_vault_scopes_and_translates_both_ways() {
        let info = GitWorkspaceInfo {
            vault_root: "/repo/notes".into(),
            git_root: Some("/repo".into()),
            vault_pathspec: Some("notes".into()),
            git_root_relation: GitRootRelation::Parent,
            resolution_failure: None,
        };
        assert_eq!(info.pathspec_args(), vec!["--", "notes/"]);
        assert_eq!(info.to_git_relative("a.md"), "notes/a.md");
        assert_eq!(info.to_vault_relative("notes/a.md"), Some("a.md".into()));
        // A file elsewhere in the repo is not part of the vault.
        assert_eq!(info.to_vault_relative("src/main.rs"), None);
    }
}
