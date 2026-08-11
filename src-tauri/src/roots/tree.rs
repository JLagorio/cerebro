//! One directory level at a time.
//!
//! The tree NEVER walks a repository. A monorepo with 200k files must open as
//! fast as an empty one, which is only true if expanding a node costs exactly
//! one readdir. This is the half of the design that scales; `index.rs` is the
//! half that answers cross-root questions.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Root-relative, forward-slashed. Empty for the root itself.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// True when git would ignore this path. Entries are RETURNED and flagged,
    /// never omitted — the UI owns the show-ignored toggle, and a backend that
    /// dropped them would make the toggle cost a second round trip.
    pub ignored: bool,
}

/// Resolve `rel` under `root`, refusing anything that escapes.
///
/// Canonicalizing BOTH sides is what defeats `../` and symlinks pointing out
/// of the tree; comparing the unresolved strings would not.
pub(super) fn resolve_within(root: &Path, rel: &str) -> Result<std::path::PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("root unavailable: {e}"))?;
    let joined = if rel.is_empty() {
        root.clone()
    } else {
        root.join(rel)
    };
    let resolved = std::fs::canonicalize(&joined).map_err(|_| format!("no such path: {rel}"))?;
    if !resolved.starts_with(&root) {
        return Err(format!("path escapes the root: {rel}"));
    }
    Ok(resolved)
}

/// Ask git which of `names` it ignores, in one call.
///
/// `check-ignore --stdin` batches the whole directory into a single process
/// spawn; asking per file would make a 500-entry folder 500 spawns.
fn ignored_set(dir: &Path, names: &[String]) -> std::collections::HashSet<String> {
    use std::io::Write;

    let mut found = std::collections::HashSet::new();
    if names.is_empty() {
        return found;
    }
    let mut command = crate::git::command::git_at(dir);
    command.args(["check-ignore", "--stdin"]);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());

    let Ok(mut child) = command.spawn() else {
        return found;
    };
    if let Some(mut pipe) = child.stdin.take() {
        let _ = pipe.write_all(names.join("\n").as_bytes());
    }
    let Ok(out) = child.wait_with_output() else {
        return found;
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            found.insert(trimmed.to_string());
        }
    }
    found
}

/// List exactly one level under `rel`. Directories first, then files, each
/// group alphabetical and case-insensitive.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<DirEntry>, String> {
    let dir = resolve_within(root, rel)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {rel}"));
    }

    let mut out = Vec::new();
    let mut names = Vec::new();
    for item in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        // One unreadable entry must not fail the whole listing.
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().to_string();
        // `.git` is machinery, not content; it is never browsable.
        if name == ".git" {
            continue;
        }
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = item.metadata().map(|m| m.len()).unwrap_or(0);
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        names.push(name.clone());
        out.push(DirEntry {
            name,
            path,
            is_dir,
            size,
            ignored: false,
        });
    }

    let ignored = ignored_set(&dir, &names);
    for entry in &mut out {
        entry.ignored = ignored.contains(&entry.name);
    }

    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn lists_one_level_only() {
        let dir = testutil::temp_vault("tree-one-level");
        testutil::write(&dir, "top.md", "# Top");
        testutil::write(&dir, "sub/nested.md", "# Nested");
        testutil::write(&dir, "sub/deeper/deep.md", "# Deep");

        let out = list_dir(&dir, "").unwrap();
        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["sub", "top.md"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn directories_sort_before_files_then_alphabetically() {
        let dir = testutil::temp_vault("tree-order");
        testutil::write(&dir, "a-file.md", "x");
        testutil::write(&dir, "z-file.md", "x");
        testutil::write(&dir, "m-dir/inner.md", "x");
        testutil::write(&dir, "b-dir/inner.md", "x");

        let names: Vec<String> = list_dir(&dir, "")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["b-dir", "m-dir", "a-file.md", "z-file.md"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn descends_into_a_subdirectory() {
        let dir = testutil::temp_vault("tree-descend");
        testutil::write(&dir, "sub/nested.md", "# Nested");
        let out = list_dir(&dir, "sub").unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "sub/nested.md");
        assert!(!out[0].is_dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_escape_the_root() {
        let dir = testutil::temp_vault("tree-escape");
        testutil::write(&dir, "inside.md", "x");
        assert!(list_dir(&dir, "../..").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn flags_gitignored_entries_without_omitting_them() {
        let dir = testutil::temp_vault("tree-ignored");
        crate::git::commit::init_repo(&dir).unwrap();
        testutil::write(&dir, ".gitignore", "secret.md\n");
        testutil::write(&dir, "secret.md", "x");
        testutil::write(&dir, "public.md", "x");

        let out = list_dir(&dir, "").unwrap();
        let secret = out
            .iter()
            .find(|e| e.name == "secret.md")
            .expect("returned, not dropped");
        let public = out.iter().find(|e| e.name == "public.md").unwrap();
        assert!(secret.ignored);
        assert!(!public.ignored);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_non_repo_flags_nothing_as_ignored() {
        let dir = testutil::temp_vault("tree-no-repo");
        testutil::write(&dir, "file.md", "x");
        assert!(list_dir(&dir, "").unwrap().iter().all(|e| !e.ignored));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_lists_the_git_directory() {
        let dir = testutil::temp_vault("tree-hides-git");
        crate::git::commit::init_repo(&dir).unwrap();
        testutil::write(&dir, "file.md", "x");
        let out = list_dir(&dir, "").unwrap();
        assert!(out.iter().all(|e| e.name != ".git"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
