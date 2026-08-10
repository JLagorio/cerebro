//! Every markdown file in a root, for the Docs tab.
//!
//! Git IS the filter. `git ls-files` returns tracked files, which excludes
//! node_modules, build output and .git for free and correctly — no ignore
//! pattern list to write, and none to drift out of date. It is git, not
//! GitHub, so it works against any remote or none at all.
//!
//! This is a SEPARATE type from `vault::Entry` on purpose. Repo markdown must
//! never reach `vaultStore`, which drives collections, types and dossiers and
//! is seeded from `scan_vault`.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedDoc {
    pub root: String,
    /// Root-relative, forward-slashed.
    pub path: String,
    /// First H1, else the humanized filename stem — same rule the vault uses.
    pub title: String,
    pub snippet: String,
    pub modified_at: String,
    /// Directory depth; 0 at the root. Drives "front door first" ordering.
    pub depth: usize,
    pub is_readme: bool,
}

fn is_markdown(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn is_readme(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .to_lowercase()
        .starts_with("readme.")
}

fn depth_of(path: &str) -> usize {
    path.matches('/').count()
}

/// Tracked markdown, via git. `None` when this is not a repository.
fn tracked_markdown(root: &Path) -> Option<Vec<String>> {
    let out =
        crate::git::command::run(root, &["ls-files", "-z", "--", "*.md", "*.markdown"]).ok()?;
    Some(
        out.split('\0')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect(),
    )
}

/// Markdown by walking, for a root that is not a repository. Reuses the same
/// skip rules the vault scanner applies.
fn walked_markdown(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let walker = walkdir::WalkDir::new(root).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        !(name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist")
    });
    for item in walker.filter_map(Result::ok) {
        if !item.file_type().is_file() {
            continue;
        }
        let Ok(rel) = item.path().strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if is_markdown(&rel) {
            out.push(rel);
        }
    }
    out
}

/// Build the markdown index for one root.
pub fn index_root(root: &Path, root_id: &str) -> Result<Vec<IndexedDoc>, String> {
    if !root.is_dir() {
        return Err(format!("root unavailable: {}", root.display()));
    }
    let paths = tracked_markdown(root).unwrap_or_else(|| walked_markdown(root));

    let mut docs = Vec::new();
    for rel in paths {
        if !is_markdown(&rel) {
            continue;
        }
        let full = root.join(&rel);
        // A tracked file missing from the working tree is not an error worth
        // failing the whole index for.
        let Ok(content) = std::fs::read_to_string(&full) else {
            continue;
        };
        let modified_at = crate::vault::scan::iso_or_now(
            std::fs::metadata(&full).and_then(|m| m.modified()).ok(),
        );

        let (_, body) = crate::vault::parse::split_frontmatter(&content);
        let filename = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let stem = filename
            .rsplit_once('.')
            .map(|(s, _)| s)
            .unwrap_or(&filename)
            .to_string();
        let title = crate::vault::parse::extract_h1_title(body)
            .unwrap_or_else(|| crate::vault::parse::humanize_stem(&stem));

        docs.push(IndexedDoc {
            root: root_id.to_string(),
            depth: depth_of(&rel),
            is_readme: is_readme(&rel),
            title,
            snippet: crate::vault::parse::extract_snippet(body),
            modified_at,
            path: rel,
        });
    }

    // Front door first: a README is what you want when you open a repo you do
    // not know. Then shallow before deep, then alphabetical.
    docs.sort_by(|a, b| {
        b.is_readme
            .cmp(&a.is_readme)
            .then_with(|| a.depth.cmp(&b.depth))
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(docs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn commit_all(dir: &Path) {
        crate::git::commit::init_repo(dir).unwrap();
        crate::git::command::run(dir, &["add", "-A"]).unwrap();
    }

    #[test]
    fn indexes_tracked_markdown_only() {
        let dir = testutil::temp_vault("index-tracked");
        testutil::write(&dir, "README.md", "# Project\n\nIntro text.");
        testutil::write(&dir, "src/main.rs", "fn main() {}");
        commit_all(&dir);

        let docs = index_root(&dir, "root-1").unwrap();
        let paths: Vec<&str> = docs.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, vec!["README.md"], "only markdown, and only tracked");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn untracked_noise_is_excluded_without_a_pattern_list() {
        let dir = testutil::temp_vault("index-noise");
        testutil::write(&dir, "README.md", "# Real");
        testutil::write(&dir, ".gitignore", "node_modules/\n");
        commit_all(&dir);
        // Written AFTER the commit and gitignored — git never tracks it.
        testutil::write(&dir, "node_modules/pkg/README.md", "# Noise");

        let docs = index_root(&dir, "root-1").unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].path, "README.md");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn derives_title_snippet_depth_and_readme_flag() {
        let dir = testutil::temp_vault("index-derive");
        testutil::write(
            &dir,
            "docs/guide/setup.md",
            "# Setting up\n\nRun the installer.",
        );
        commit_all(&dir);

        let docs = index_root(&dir, "root-1").unwrap();
        let doc = &docs[0];
        assert_eq!(doc.root, "root-1");
        assert_eq!(doc.title, "Setting up");
        assert!(doc.snippet.contains("Run the installer"));
        assert_eq!(
            doc.depth, 2,
            "docs/guide/setup.md sits two directories deep"
        );
        assert!(!doc.is_readme);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recognises_readme_case_insensitively() {
        let dir = testutil::temp_vault("index-readme");
        testutil::write(&dir, "ReadMe.md", "# Hi");
        commit_all(&dir);
        assert!(index_root(&dir, "root-1").unwrap()[0].is_readme);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_non_repo_falls_back_to_walking() {
        let dir = testutil::temp_vault("index-no-repo");
        testutil::write(&dir, "notes.md", "# Notes");
        testutil::write(&dir, ".hidden/skip.md", "# Skipped");

        let docs = index_root(&dir, "root-1").unwrap();
        let paths: Vec<&str> = docs.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["notes.md"],
            "dot-dirs stay skipped in the fallback"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sorts_readmes_first_then_depth_then_title() {
        let dir = testutil::temp_vault("index-sort");
        testutil::write(&dir, "docs/deep/z.md", "# Zeta");
        testutil::write(&dir, "docs/a.md", "# Alpha");
        testutil::write(&dir, "README.md", "# Front door");
        commit_all(&dir);

        let paths: Vec<String> = index_root(&dir, "root-1")
            .unwrap()
            .into_iter()
            .map(|d| d.path)
            .collect();
        assert_eq!(paths, vec!["README.md", "docs/a.md", "docs/deep/z.md"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamps_are_iso_8601() {
        let dir = testutil::temp_vault("index-times");
        testutil::write(&dir, "README.md", "# Hi");
        commit_all(&dir);
        let docs = index_root(&dir, "root-1").unwrap();
        assert!(
            chrono::DateTime::parse_from_rfc3339(&docs[0].modified_at).is_ok(),
            "{}",
            docs[0].modified_at
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_root_is_an_error_not_an_empty_index() {
        assert!(index_root(Path::new("/nonexistent/cerebro/root"), "root-1").is_err());
    }
}
