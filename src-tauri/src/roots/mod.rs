//! Mounted roots: the workspace is 1+N directories, not one vault.
//!
//! A root is described by what it CAN DO, not by what it is called. AGENTS.md
//! forbids routing on type names, so there is no `kind: vault | repo` field —
//! `RootCaps` is probed from disk and every consumer gates on a capability.

use serde::{Deserialize, Serialize};
use std::path::Path;

pub mod index;
pub mod read;
pub mod store;
pub mod tree;

/// What a root can do. Probed from disk, never declared by the user.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RootCaps {
    /// Carries a `knowledge/` bundle (and, later, a ledger).
    pub knowledge: bool,
    /// Is a git repository.
    pub git: bool,
    /// Mutations are permitted at all.
    pub writable: bool,
}

/// One mounted directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    /// Generated once at mount. NOT derived from the path — moving a repo on
    /// disk must not orphan every reference to it.
    pub id: String,
    pub path: String,
    pub label: String,
    /// Reserved for the cross-root reference form `alias:relative/path.md`.
    /// Nothing reads it yet (M30 spec, section 1.6).
    pub alias: String,
    #[serde(default)]
    pub color: Option<String>,
    pub caps: RootCaps,
}

/// Probe a directory's capabilities.
///
/// A path that does not exist probes to nothing rather than erroring: an
/// unplugged external drive is a root that is temporarily unavailable, not a
/// malformed one, and the tree renders it as such.
pub fn probe(path: impl AsRef<Path>) -> RootCaps {
    let path = path.as_ref();
    if !path.is_dir() {
        return RootCaps::default();
    }
    RootCaps {
        knowledge: path.join(crate::knowledge::KNOWLEDGE_DIR).is_dir(),
        git: crate::git::workspace::resolve(path).is_repo(),
        writable: !path
            .metadata()
            .map(|m| m.permissions().readonly())
            .unwrap_or(true),
    }
}

/// A refusal the UI is expected to READ and act on, not toast away.
///
/// `code` is matched by callers; `message` is shown. A bare string would force
/// the UI to pattern-match prose to tell "already mounted" from "no such
/// directory", which are different affordances.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MountRefusal {
    pub code: String,
    pub message: String,
}

impl MountRefusal {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// Lowercase, dash-separated, alphanumerics only — a slug safe to use as a
/// reference prefix later without quoting.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Make `base` unique against everything already taken, by suffixing -2, -3, …
fn unique_alias(base: &str, taken: &[Root]) -> String {
    let base = if base.is_empty() {
        "root".to_string()
    } else {
        base.to_string()
    };
    if !taken.iter().any(|r| r.alias == base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|c| !taken.iter().any(|r| &r.alias == c))
        .unwrap_or_else(|| base.clone())
}

pub fn list(config_dir: &Path) -> Vec<Root> {
    store::load(config_dir)
}

/// Attach a directory that already exists on disk.
///
/// Cerebro never creates or owns a checkout (M30 roadmap, decision 4) — this
/// only ever adds a path to a list.
pub fn mount(config_dir: &Path, path: &str) -> Result<Root, MountRefusal> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| MountRefusal::new("not_a_directory", format!("{path} is not a directory")))?;
    if !canonical.is_dir() {
        return Err(MountRefusal::new(
            "not_a_directory",
            format!("{path} is not a directory"),
        ));
    }
    let canonical_str = canonical.to_string_lossy().to_string();

    let mut roots = store::load(config_dir);
    if let Some(existing) = roots.iter().find(|r| r.path == canonical_str) {
        return Err(MountRefusal::new(
            "already_mounted",
            format!(
                "{} is already mounted as \"{}\"",
                canonical_str, existing.label
            ),
        ));
    }

    let caps = probe(&canonical);

    // The v1 invariant. A refusal, not a disabled button: knowledge.rs states
    // the principle — "a disabled button is a suggestion, a rejected command is
    // a rule". Naming the incumbent is what makes it actionable.
    if caps.knowledge {
        if let Some(existing) = roots.iter().find(|r| r.caps.knowledge) {
            return Err(MountRefusal::new(
                "knowledge_root_exists",
                format!(
                    "\"{}\" already holds this workspace's knowledge base. \
                     Cerebro supports one knowledge root; unmount it first.",
                    existing.label
                ),
            ));
        }
    }

    let label = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical_str.clone());
    let alias = unique_alias(&slugify(&label), &roots);
    let id = format!("root-{}-{}", alias, roots.len() + 1);

    let root = Root {
        id,
        path: canonical_str,
        label,
        alias,
        color: None,
        caps,
    };
    roots.push(root.clone());
    store::save(config_dir, &roots).map_err(|e| MountRefusal::new("persist_failed", e))?;
    Ok(root)
}

/// Detach a root. Never touches the directory itself.
pub fn unmount(config_dir: &Path, id: &str) -> Result<(), String> {
    let mut roots = store::load(config_dir);
    let before = roots.len();
    roots.retain(|r| r.id != id);
    if roots.len() == before {
        return Err(format!("no mounted root with id {id}"));
    }
    store::save(config_dir, &roots)
}

/// Look up a mounted root by id.
pub fn find(config_dir: &Path, id: &str) -> Option<Root> {
    store::load(config_dir).into_iter().find(|r| r.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn probes_plain_directory_as_no_capabilities() {
        let dir = testutil::temp_vault("roots-plain");
        let caps = probe(&dir);
        assert!(!caps.knowledge, "no knowledge/ dir");
        assert!(!caps.git, "not a repo");
        assert!(caps.writable, "a writable temp dir");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probes_knowledge_bundle() {
        let dir = testutil::temp_vault("roots-knowledge");
        std::fs::create_dir_all(dir.join("knowledge")).unwrap();
        assert!(probe(&dir).knowledge);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn knowledge_requires_a_directory_not_a_file() {
        let dir = testutil::temp_vault("roots-knowledge-file");
        testutil::write(&dir, "knowledge", "not a directory");
        assert!(!probe(&dir).knowledge);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probes_git_repository() {
        let dir = testutil::temp_vault("roots-git");
        crate::git::commit::init_repo(&dir).unwrap();
        assert!(probe(&dir).git);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_directory_probes_to_nothing() {
        let caps = probe(Path::new("/nonexistent/cerebro/root"));
        assert!(!caps.knowledge && !caps.git && !caps.writable);
    }

    #[test]
    fn mount_derives_label_and_alias_from_basename() {
        let cfg = testutil::temp_vault("roots-mount-cfg");
        let repo = testutil::temp_vault("My Repo");
        let root = mount(&cfg, repo.to_str().unwrap()).unwrap();
        assert_eq!(root.label, repo.file_name().unwrap().to_str().unwrap());
        assert!(!root.alias.is_empty());
        assert!(!root.id.is_empty());
        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn mount_persists_so_list_sees_it() {
        let cfg = testutil::temp_vault("roots-mount-persist");
        let repo = testutil::temp_vault("roots-mount-persist-repo");
        mount(&cfg, repo.to_str().unwrap()).unwrap();
        assert_eq!(list(&cfg).len(), 1);
        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn mounting_the_same_path_twice_is_refused() {
        let cfg = testutil::temp_vault("roots-mount-dupe");
        let repo = testutil::temp_vault("roots-mount-dupe-repo");
        mount(&cfg, repo.to_str().unwrap()).unwrap();
        let err = mount(&cfg, repo.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, "already_mounted");
        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_second_knowledge_root_is_refused_and_names_the_first() {
        let cfg = testutil::temp_vault("roots-two-brains");
        let first = testutil::temp_vault("roots-brain-one");
        let second = testutil::temp_vault("roots-brain-two");
        std::fs::create_dir_all(first.join("knowledge")).unwrap();
        std::fs::create_dir_all(second.join("knowledge")).unwrap();

        mount(&cfg, first.to_str().unwrap()).unwrap();
        let err = mount(&cfg, second.to_str().unwrap()).unwrap_err();

        assert_eq!(err.code, "knowledge_root_exists");
        assert!(
            err.message
                .contains(first.file_name().unwrap().to_str().unwrap()),
            "the refusal must name the existing knowledge root, got: {}",
            err.message
        );
        assert_eq!(
            list(&cfg).len(),
            1,
            "the refused root must not be persisted"
        );

        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&first);
        let _ = std::fs::remove_dir_all(&second);
    }

    #[test]
    fn mounting_a_missing_directory_is_refused() {
        let cfg = testutil::temp_vault("roots-mount-missing");
        let err = mount(&cfg, "/nonexistent/cerebro/root").unwrap_err();
        assert_eq!(err.code, "not_a_directory");
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn unmount_removes_only_the_named_root() {
        let cfg = testutil::temp_vault("roots-unmount");
        let a = testutil::temp_vault("roots-unmount-a");
        let b = testutil::temp_vault("roots-unmount-b");
        let ra = mount(&cfg, a.to_str().unwrap()).unwrap();
        mount(&cfg, b.to_str().unwrap()).unwrap();

        unmount(&cfg, &ra.id).unwrap();

        let remaining = list(&cfg);
        assert_eq!(remaining.len(), 1);
        assert_ne!(remaining[0].id, ra.id);

        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn alias_collisions_get_a_suffix() {
        let cfg = testutil::temp_vault("roots-alias-collide");
        let a = testutil::temp_vault("shared-name").join("repo");
        let b = testutil::temp_vault("shared-name-other").join("repo");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let ra = mount(&cfg, a.to_str().unwrap()).unwrap();
        let rb = mount(&cfg, b.to_str().unwrap()).unwrap();

        assert_eq!(ra.alias, "repo");
        assert_eq!(rb.alias, "repo-2");
        assert_ne!(ra.id, rb.id);

        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(a.parent().unwrap());
        let _ = std::fs::remove_dir_all(b.parent().unwrap());
    }
}
