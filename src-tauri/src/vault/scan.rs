//! Walk a vault folder and produce an Entry per markdown file.

use std::path::Path;

use walkdir::WalkDir;

use super::entry::{build_entry, Entry};

const SKIPPED_DIRS: [&str; 2] = ["views", "attachments"];

fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

fn keep(item: &walkdir::DirEntry) -> bool {
    if !item.file_type().is_dir() {
        return true;
    }
    !is_skipped_dir(&item.file_name().to_string_lossy())
}

fn rel_path(vault: &Path, path: &Path) -> Result<String, String> {
    let rel = path.strip_prefix(vault).map_err(|e| e.to_string())?;
    Ok(rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn iso_or_now(t: Option<std::time::SystemTime>) -> String {
    let t = t.unwrap_or_else(std::time::SystemTime::now);
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn timestamps(path: &Path) -> (String, String) {
    let meta = std::fs::metadata(path).ok();
    let modified = meta.as_ref().and_then(|m| m.modified().ok());
    let created = meta.as_ref().and_then(|m| m.created().ok()).or(modified);
    (iso_or_now(created), iso_or_now(modified))
}

/// Scan every `.md` file in the vault (skipping dot-directories, `views/`,
/// and `attachments/`) into Entries with vault-relative forward-slash paths,
/// sorted by path.
pub fn scan_vault(vault: &Path) -> Result<Vec<Entry>, String> {
    if !vault.is_dir() {
        return Err(format!("not a directory: {}", vault.display()));
    }
    let mut entries = Vec::new();
    let walker = WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || keep(e));
    for item in walker {
        // M1.x per-file degrade: an unreadable directory entry must not abort
        // the whole scan.
        let Ok(item) = item else { continue };
        if !item.file_type().is_file() {
            continue;
        }
        if item.path().extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let rel = rel_path(vault, item.path())?;
        let (created, modified) = timestamps(item.path());
        // M1.x per-file degrade: one unreadable/non-UTF-8 .md used to abort
        // the whole scan — degrade to a parse_error entry the UI can show.
        let entry = match std::fs::read_to_string(item.path()) {
            Ok(content) => build_entry(&rel, &content, created, modified),
            Err(e) => {
                let mut entry = build_entry(&rel, "", created, modified);
                entry.parse_error = Some(format!("unreadable: {e}"));
                entry
            }
        };
        entries.push(entry);
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    assign_projects(&mut entries);
    Ok(entries)
}

/// Vault format v2 containment post-pass: an entry's project is the nearest
/// ancestor directory holding a `project.md` (parity with assignProjects in
/// mockIpc.ts). A vault-root project.md is ignored — it would own every file.
fn assign_projects(entries: &mut [Entry]) {
    let project_dirs: Vec<String> = entries
        .iter()
        .filter(|e| e.path.ends_with("/project.md"))
        .map(|e| e.path.trim_end_matches("/project.md").to_string())
        .collect();
    for entry in entries.iter_mut() {
        let mut best: Option<&String> = None;
        for dir in &project_dirs {
            if entry.path.starts_with(&format!("{dir}/"))
                && best.map_or(true, |b| dir.len() > b.len())
            {
                best = Some(dir);
            }
        }
        entry.project = best.map(|d| format!("{d}/project.md"));
    }
}

/// All directories in the vault (vault-relative, sorted), skipping the same
/// dirs the scanner skips. Feeds folder trees — empty folders included.
pub fn list_folders(vault: &Path) -> Result<Vec<String>, String> {
    if !vault.is_dir() {
        return Err(format!("not a directory: {}", vault.display()));
    }
    let mut dirs = Vec::new();
    let walker = WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || keep(e));
    for item in walker {
        let Ok(item) = item else { continue };
        if item.depth() == 0 || !item.file_type().is_dir() {
            continue;
        }
        dirs.push(rel_path(vault, item.path())?);
    }
    dirs.sort();
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use std::path::PathBuf;

    /// A small but representative v2 vault: a type note, a project carrying
    /// a statuses override, two items, one malformed item — plus files that
    /// must be skipped (views/, attachments/, dot-dir, non-md).
    fn fixture_vault(label: &str) -> PathBuf {
        let vault = testutil::temp_vault(label);
        testutil::write(&vault, "type/work-item.md", "---\ntype: Type\nicon: check-square\nfields:\n  status: { kind: status }\n  priority: { kind: select }\n---\n\n# Work item\n");
        testutil::write(&vault, "people/maya-chen.md", "---\ntype: Person\n---\n\n# Maya Chen\n");
        testutil::write(&vault, "projects/atlas.md", "---\ntype: Project\nkey: ATL\nlead: \"[[maya-chen]]\"\nstatuses:\n  - { id: todo, group: active, color: '#3D8BE8' }\n  - { id: done, group: done, color: '#34B764' }\n---\n\n# Atlas\n");
        testutil::write(&vault, "items/atl-1.md", "---\ntype: Work item\nkey: ATL-1\nstatus: todo\n---\n\n# Ship the scanner\n");
        testutil::write(&vault, "items/atl-2.md", "---\ntype: Work item\nkey: ATL-2\nstatus: done\n---\n\n# Parse frontmatter\n");
        testutil::write(&vault, "items/broken.md", "---\nstatus: [unclosed\n---\n\n# Broken item\n");
        testutil::write(&vault, "views/all-items.yml", "name: All items\n");
        testutil::write(&vault, "attachments/readme.md", "# Not scanned\n");
        testutil::write(&vault, ".obsidian/workspace.md", "# Hidden\n");
        testutil::write(&vault, "notes.txt", "not markdown\n");
        vault
    }

    #[test]
    fn scans_only_markdown_files_sorted_by_relative_path() {
        let vault = fixture_vault("scan-paths");
        let entries = scan_vault(&vault).unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "items/atl-1.md",
                "items/atl-2.md",
                "items/broken.md",
                "people/maya-chen.md",
                "projects/atlas.md",
                "type/work-item.md",
            ]
        );
        assert!(entries.iter().all(|e| !e.path.contains('\\')));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn skips_views_attachments_and_dot_dirs() {
        let vault = fixture_vault("scan-skips");
        let entries = scan_vault(&vault).unwrap();
        assert!(entries.iter().all(|e| {
            !e.path.starts_with("views/")
                && !e.path.starts_with("attachments/")
                && !e.path.starts_with(".obsidian/")
                && e.path.ends_with(".md")
        }));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn malformed_file_yields_parse_error_entry_and_scan_succeeds() {
        let vault = fixture_vault("scan-broken");
        let entries = scan_vault(&vault).unwrap();
        let broken = entries.iter().find(|e| e.path == "items/broken.md").unwrap();
        assert!(broken.parse_error.is_some());
        assert_eq!(broken.title, "Broken item");
        assert!(entries.iter().filter(|e| e.parse_error.is_some()).count() == 1);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn extracts_relationships_and_complex_properties() {
        let vault = fixture_vault("scan-props");
        let entries = scan_vault(&vault).unwrap();
        let project = entries.iter().find(|e| e.path == "projects/atlas.md").unwrap();
        assert_eq!(project.relationships["lead"], vec!["maya-chen"]);
        // v2: the statuses override is nested YAML on the project itself.
        assert_eq!(project.properties["statuses"].as_array().unwrap().len(), 2);
        let type_note = entries.iter().find(|e| e.path == "type/work-item.md").unwrap();
        assert_eq!(type_note.properties["fields"]["status"]["kind"], "status");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn timestamps_are_iso_8601() {
        let vault = fixture_vault("scan-times");
        let entries = scan_vault(&vault).unwrap();
        for e in &entries {
            assert!(chrono::DateTime::parse_from_rfc3339(&e.created_at).is_ok(), "{}", e.created_at);
            assert!(chrono::DateTime::parse_from_rfc3339(&e.modified_at).is_ok(), "{}", e.modified_at);
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn nonexistent_vault_errors() {
        assert!(scan_vault(Path::new("/definitely/not/a/real/vault")).is_err());
    }

    #[test]
    fn v2_containment_resolves_nearest_project_and_folder() {
        let vault = testutil::temp_vault("scan-v2");
        testutil::write(&vault, "projects/atlas/project.md", "---\ntype: Project\nkey: ATL\n---\n\n# Atlas\n");
        testutil::write(&vault, "projects/atlas/items/atl-1.md", "---\ntype: Work item\n---\n\n# One\n");
        testutil::write(&vault, "projects/atlas/meetings/kickoff.md", "# Kickoff\n");
        testutil::write(&vault, "projects/atlas/sub/project.md", "---\ntype: Project\n---\n\n# Sub\n");
        testutil::write(&vault, "projects/atlas/sub/notes.md", "# Notes\n");
        testutil::write(&vault, "inbox/loose.md", "# Loose\n");
        let entries = scan_vault(&vault).unwrap();
        let get = |p: &str| entries.iter().find(|e| e.path == p).unwrap();
        assert_eq!(
            get("projects/atlas/items/atl-1.md").project.as_deref(),
            Some("projects/atlas/project.md")
        );
        assert_eq!(get("projects/atlas/items/atl-1.md").folder, "projects/atlas/items");
        assert_eq!(
            get("projects/atlas/meetings/kickoff.md").project.as_deref(),
            Some("projects/atlas/project.md")
        );
        // Nearest ancestor project wins for nested projects.
        assert_eq!(
            get("projects/atlas/sub/notes.md").project.as_deref(),
            Some("projects/atlas/sub/project.md")
        );
        // The project doc belongs to its own project.
        assert_eq!(
            get("projects/atlas/project.md").project.as_deref(),
            Some("projects/atlas/project.md")
        );
        assert_eq!(get("inbox/loose.md").project, None);
        assert_eq!(get("inbox/loose.md").folder, "inbox");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn list_folders_returns_sorted_dirs_including_empty_skipping_special() {
        let vault = fixture_vault("scan-folders");
        std::fs::create_dir_all(vault.join("projects/empty-folder")).unwrap();
        let dirs = list_folders(&vault).unwrap();
        assert!(dirs.contains(&"items".to_string()));
        assert!(dirs.contains(&"projects".to_string()));
        assert!(dirs.contains(&"projects/empty-folder".to_string()));
        assert!(!dirs
            .iter()
            .any(|d| d.starts_with("views") || d.starts_with(".obsidian") || d.starts_with("attachments")));
        let mut sorted = dirs.clone();
        sorted.sort();
        assert_eq!(dirs, sorted);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn non_utf8_file_degrades_to_parse_error_entry_and_scan_succeeds() {
        let vault = fixture_vault("scan-nonutf8");
        std::fs::write(vault.join("items/bad.md"), [0xFF, 0xFE, 0x00, 0x80]).unwrap();
        let entries = scan_vault(&vault).unwrap();
        let bad = entries.iter().find(|e| e.path == "items/bad.md").unwrap();
        assert!(bad.parse_error.as_deref().unwrap().starts_with("unreadable:"));
        assert_eq!(bad.title, "Bad");
        // The rest of the vault still scanned normally.
        assert!(entries.iter().any(|e| e.path == "items/atl-1.md" && e.parse_error.is_none()));
        let _ = std::fs::remove_dir_all(&vault);
    }
}
