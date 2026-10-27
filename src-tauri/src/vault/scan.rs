//! Walk a vault and list markdown pages, Mermaid diagrams and JSON Canvas boards.

use std::io::Read;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use super::entry::{build_entry, Entry};

const SKIPPED_DIRS: [&str; 2] = ["views", "attachments"];

/// A code point HFS+ ignores in a name, as git's `core.protectHFS` lists
/// them: the zero-width non-joiner and joiner, the direction marks, the
/// bidirectional embeddings and overrides, the deprecated format characters
/// and the byte order mark. On such a disk `\u{200c}.claude` IS `.claude`.
pub(crate) fn hfs_ignorable(c: char) -> bool {
    matches!(
        c,
        '\u{200c}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{206a}'..='\u{206f}' | '\u{feff}'
    )
}

/// A dotfile or a dot-folder, Obsidian-style, heard as HFS+ hears the name:
/// its first character that is not [`hfs_ignorable`] is `.`. The scan hides
/// it, and the note writers refuse it with this same predicate (write.rs
/// `note_refusal`), so no listed note is one they refuse.
pub(crate) fn is_hidden(name: &str) -> bool {
    name.chars().find(|c| !hfs_ignorable(*c)) == Some('.')
}

/// A folder the scan never descends into: a hidden one, or one named exactly
/// `views` or `attachments`, at any depth. The note writers ask this same
/// predicate (write.rs `note_refusal`), so a note the scan lists is a note
/// they will save.
pub(crate) fn is_skipped_dir(name: &str) -> bool {
    is_hidden(name) || SKIPPED_DIRS.contains(&name)
}

/// The walk's filter: a folder the scan descends into, or a file it is not
/// hiding.
fn keep(item: &walkdir::DirEntry) -> bool {
    let name = item.file_name().to_string_lossy();
    if item.file_type().is_dir() {
        !is_skipped_dir(&name)
    } else {
        !is_hidden(&name)
    }
}

fn rel_path(vault: &Path, path: &Path) -> Result<String, String> {
    let rel = path.strip_prefix(vault).map_err(|e| e.to_string())?;
    Ok(rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

/// A file time as RFC 3339 UTC, or now when the disk recorded none. That
/// fallback reads a missing time as a fresh write, so list_notes (M59.5)
/// cannot tell the two apart and sorts such a note newest. Saying "not
/// recorded" instead needs an `Option` on `Entry`'s times, a change across
/// the TypeScript too, left for a later part.
fn iso_or_now(t: Option<std::time::SystemTime>) -> String {
    let t = t.unwrap_or_else(std::time::SystemTime::now);
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub(crate) fn timestamps(meta: Option<&std::fs::Metadata>) -> (String, String) {
    let modified = meta.and_then(|m| m.modified().ok());
    let created = meta.and_then(|m| m.created().ok()).or(modified);
    (iso_or_now(created), iso_or_now(modified))
}

/// One note file the walk found: its vault-relative forward-slash path,
/// where it sits on disk, and its metadata, or `None` when it could not be
/// read (M59.4).
pub(crate) struct NoteFile {
    pub rel: String,
    pub path: PathBuf,
    pub meta: Option<std::fs::Metadata>,
    boundary: std::sync::Arc<crate::workspace_service::boundary::Inspection>,
}

/// The scan's walk (M59.4): every page, diagram and whiteboard, in
/// walk order. Dotfiles and dot-folders are hidden, Obsidian-style
/// ([`is_hidden`]), and `views/` and `attachments/` are skipped. The scan
/// and search's corpus (`vault/corpus.rs`) both walk with it, so the two
/// can never list different notes.
pub(crate) struct NoteInventory {
    pub files: Vec<NoteFile>,
    pub boundary: std::sync::Arc<crate::workspace_service::boundary::Inspection>,
}
pub(crate) fn note_files(vault: &Path) -> Result<NoteInventory, String> {
    let boundary = std::sync::Arc::new(
        crate::workspace_service::boundary::inspect_legacy_tree(vault).map_err(|e| e.message)?,
    );
    if !vault.is_dir() {
        return Err(format!("not a directory: {}", vault.display()));
    }
    let mut files = Vec::new();
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
        if !matches!(
            item.path().extension().and_then(|e| e.to_str()),
            Some("md") | Some("mmd")
        ) && !crate::files::kinds::is_whiteboard(&item.path().to_string_lossy())
        {
            continue;
        }
        files.push(NoteFile {
            rel: rel_path(vault, item.path())?,
            path: item.path().to_path_buf(),
            meta: std::fs::metadata(item.path()).ok(),
            boundary: boundary.clone(),
        });
    }
    boundary.revalidate().map_err(|e| e.message)?;
    Ok(NoteInventory { files, boundary })
}

/// A board's size is checked on the opened file before allocating its body;
/// the bounded read also closes a growth race after metadata. Scan and search
/// share this one read, including unavailable UTF-8 and over-limit boards.
pub(crate) fn read_content(
    file: &NoteFile,
) -> Result<std::io::Result<String>, crate::workspace_service::types::selected::AuthorityError> {
    let mut source = match file.boundary.open_file_or_io(&file.path)? {
        Ok(source) => source,
        Err(unreadable) => return Ok(Err(unreadable)),
    };
    let read = (|| -> std::io::Result<String> {
        if !crate::files::kinds::is_whiteboard(&file.rel) {
            let mut text = String::new();
            source.read_to_string(&mut text)?;
            return Ok(text);
        }
        let limit = crate::canvas::format::table().limits.max_bytes;
        let too_large =
            || std::io::Error::other(format!("This whiteboard is over the {limit} byte limit."));
        if source.metadata()?.len() > limit as u64 {
            return Err(too_large());
        }
        let mut bytes = Vec::new();
        source.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(too_large());
        }
        String::from_utf8(bytes).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "This whiteboard is not valid UTF-8 text.",
            )
        })
    })();
    Ok(read)
}

/// One note's Entry from what reading it gave (M59.4): the scan and search's
/// corpus build every entry here, from the one read each makes.
pub(crate) fn entry_from_read(
    rel: &str,
    read: &std::io::Result<String>,
    meta: Option<&std::fs::Metadata>,
) -> Entry {
    let (created, modified) = timestamps(meta);
    match read {
        Ok(content) => build_entry(rel, content, created, modified),
        // M1.x per-file degrade: one unreadable/non-UTF-8 .md used to abort
        // the whole scan — degrade to a parse_error entry the UI can show.
        Err(e) => {
            let mut entry = build_entry(rel, "", created, modified);
            entry.parse_error = Some(format!("unreadable: {e}"));
            // The empty string stood in for bytes nobody read, so its
            // hash names nothing on disk: not recorded (M55.2).
            entry.hash = None;
            entry
        }
    }
}

/// Scan every page, Mermaid diagram and JSON Canvas board into Entries with
/// vault-relative forward-slash paths, sorted by path: [`note_files`]'s
/// walk, one read per file, [`entry_from_read`], then project containment.
pub fn scan_vault(vault: &Path) -> Result<Vec<Entry>, String> {
    scan_vault_filtered(vault, |_| true)
}

/// Filter paths before their bytes are opened (ambient ingest excludes mail).
pub(crate) fn scan_vault_filtered(
    vault: &Path,
    include: impl Fn(&str) -> bool,
) -> Result<Vec<Entry>, String> {
    if matches!(
        crate::workspace_service::authority::resolve(vault).map_err(|e| e.message)?,
        crate::workspace_service::authority::Authority::Selected
    ) {
        return crate::workspace_service::selected::scan_filtered(vault, include)
            .map_err(|e| e.message);
    }
    let inventory = note_files(vault)?;
    let mut entries: Vec<Entry> = inventory
        .files
        .iter()
        .filter(|file| include(&file.rel))
        .map(|file| {
            let read = read_content(file).map_err(|e| e.message)?;
            Ok(entry_from_read(&file.rel, &read, file.meta.as_ref()))
        })
        .collect::<Result<Vec<_>, String>>()?;
    inventory.boundary.revalidate().map_err(|e| e.message)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    assign_projects(&mut entries);
    Ok(entries)
}

/// Vault format v2 containment post-pass: an entry's project is the nearest
/// ancestor directory holding a `project.md` (parity with assignProjects in
/// mockIpc.ts). A vault-root project.md is ignored — it would own every file.
pub(crate) fn assign_projects(entries: &mut [Entry]) {
    let project_dirs: Vec<String> = entries
        .iter()
        .filter(|e| e.path.ends_with("/project.md"))
        .map(|e| e.path.trim_end_matches("/project.md").to_string())
        .collect();
    for entry in entries.iter_mut() {
        let mut best: Option<&String> = None;
        for dir in &project_dirs {
            if entry.path.starts_with(&format!("{dir}/"))
                && best.is_none_or(|b| dir.len() > b.len())
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
    if matches!(
        crate::workspace_service::authority::resolve(vault).map_err(|e| e.message)?,
        crate::workspace_service::authority::Authority::Selected
    ) {
        return crate::workspace_service::selected::folders(vault).map_err(|e| e.message);
    }
    crate::workspace_service::boundary::guard_legacy_scope(vault, None, true)
        .map_err(|e| e.message)?;
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
    /// must be skipped (views/, attachments/, a dot-dir, a dotfile, a dot-dir
    /// HFS+ hears behind a U+200C, non-md).
    fn fixture_vault(label: &str) -> PathBuf {
        let vault = testutil::temp_vault(label);
        testutil::write(&vault, "type/work-item.md", "---\ntype: Type\nicon: check-square\nfields:\n  status: { kind: status }\n  priority: { kind: select }\n---\n\n# Work item\n");
        testutil::write(
            &vault,
            "people/maya-chen.md",
            "---\ntype: Person\n---\n\n# Maya Chen\n",
        );
        testutil::write(&vault, "projects/atlas.md", "---\ntype: Project\nkey: ATL\nlead: \"[[maya-chen]]\"\nstatuses:\n  - { id: todo, group: active, color: '#3D8BE8' }\n  - { id: done, group: done, color: '#34B764' }\n---\n\n# Atlas\n");
        testutil::write(
            &vault,
            "items/atl-1.md",
            "---\ntype: Work item\nkey: ATL-1\nstatus: todo\n---\n\n# Ship the scanner\n",
        );
        testutil::write(
            &vault,
            "items/atl-2.md",
            "---\ntype: Work item\nkey: ATL-2\nstatus: done\n---\n\n# Parse frontmatter\n",
        );
        testutil::write(
            &vault,
            "items/broken.md",
            "---\nstatus: [unclosed\n---\n\n# Broken item\n",
        );
        testutil::write(
            &vault,
            "diagrams/pipeline.mmd",
            "---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A[Ingest] --> B[Distill]\n",
        );
        testutil::write(&vault, "views/all-items.yml", "name: All items\n");
        testutil::write(&vault, "attachments/readme.md", "# Not scanned\n");
        testutil::write(&vault, ".obsidian/workspace.md", "# Hidden\n");
        testutil::write(
            &vault,
            "items/.draft.md",
            "---\ntype: Work item\nstatus: todo\n---\n\n# Hidden draft\n",
        );
        testutil::write(&vault, "\u{200c}.notes/x.md", "# Hidden too\n");
        testutil::write(&vault, "notes.txt", "not markdown\n");
        testutil::write(
            &vault,
            "boards/plan.canvas",
            include_str!("../../../shared/canvas/goldens/obsidian-layout.canvas"),
        );
        vault
    }

    #[test]
    fn scans_notes_diagrams_and_boards_sorted_by_relative_path() {
        let vault = fixture_vault("scan-paths");
        let entries = scan_vault(&vault).unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "boards/plan.canvas",
                "diagrams/pipeline.mmd",
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
    fn whiteboards_have_card_facts_and_unreadable_ones_keep_their_entry() {
        let vault = fixture_vault("scan-whiteboards");
        testutil::write(&vault, "boards/broken.canvas", "{\"nodes\":[");
        let entries = scan_vault(&vault).unwrap();
        let board = entries
            .iter()
            .find(|e| e.path == "boards/plan.canvas")
            .unwrap();
        assert_eq!(board.title, "Plan");
        assert_eq!(board.snippet, "Roadmap Vision Release");
        assert_eq!(board.outgoing_links, ["Vision", "Launch#Next"]);
        assert!(board.entry_type.is_none() && board.properties.is_empty());
        assert!(board.hash.is_some() && board.parse_error.is_none());
        let broken = entries
            .iter()
            .find(|e| e.path == "boards/broken.canvas")
            .unwrap();
        assert_eq!(
            broken.parse_error.as_deref(),
            Some("This whiteboard isn't valid JSON.")
        );
        assert!(broken.hash.is_some());
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn an_oversized_board_is_unavailable_without_reading_its_body() {
        let vault = testutil::temp_vault("scan-board-cap");
        let path = vault.join("large.canvas");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(crate::canvas::format::table().limits.max_bytes as u64 + 1)
            .unwrap();
        let entry = scan_vault(&vault).unwrap().pop().unwrap();
        assert_eq!(entry.hash, None);
        assert!(entry
            .parse_error
            .unwrap()
            .contains("over the 8388608 byte limit"));
        std::fs::remove_dir_all(vault).unwrap();
    }

    // M29.20: a .mmd is RAW diagram source. Mermaid's own `---` config header
    // is diagram syntax, so it must never parse as note frontmatter.
    #[test]
    fn mmd_files_scan_as_raw_untyped_entries() {
        let vault = fixture_vault("scan-mmd");
        let entries = scan_vault(&vault).unwrap();
        let mmd = entries
            .iter()
            .find(|e| e.path == "diagrams/pipeline.mmd")
            .unwrap();
        assert_eq!(mmd.title, "Pipeline");
        assert_eq!(mmd.entry_type, None);
        assert!(mmd.properties.is_empty());
        assert!(mmd.relationships.is_empty());
        assert!(mmd.outgoing_links.is_empty());
        assert_eq!(mmd.snippet, "flowchart TD");
        assert!(mmd.parse_error.is_none());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M53.25: a dotfile note is hidden, Obsidian-style, as a dot-folder is,
    // and a name is heard as HFS+ hears it — the rule the note writers
    // refuse by, so the scan never lists a page they will not save.
    #[test]
    fn skips_dotfiles_dot_dirs_views_and_attachments() {
        let vault = fixture_vault("scan-skips");
        let entries = scan_vault(&vault).unwrap();
        assert!(entries.iter().all(|e| {
            !e.path.starts_with("views/")
                && !e.path.starts_with("attachments/")
                && !e.path.split('/').any(is_hidden)
                && (e.path.ends_with(".md")
                    || e.path.ends_with(".mmd")
                    || crate::files::kinds::is_whiteboard(&e.path))
        }));
        for hidden in [
            ".obsidian/workspace.md",
            "items/.draft.md",
            "\u{200c}.notes/x.md",
        ] {
            assert!(vault.join(hidden).is_file(), "{hidden} is in the fixture");
            assert!(
                entries.iter().all(|e| e.path != hidden),
                "{hidden} is listed"
            );
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn malformed_file_yields_parse_error_entry_and_scan_succeeds() {
        let vault = fixture_vault("scan-broken");
        let entries = scan_vault(&vault).unwrap();
        let broken = entries
            .iter()
            .find(|e| e.path == "items/broken.md")
            .unwrap();
        assert!(broken.parse_error.is_some());
        assert_eq!(broken.title, "Broken item");
        assert!(entries.iter().filter(|e| e.parse_error.is_some()).count() == 1);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn extracts_relationships_and_complex_properties() {
        let vault = fixture_vault("scan-props");
        let entries = scan_vault(&vault).unwrap();
        let project = entries
            .iter()
            .find(|e| e.path == "projects/atlas.md")
            .unwrap();
        assert_eq!(project.relationships["lead"], vec!["maya-chen"]);
        // v2: the statuses override is nested YAML on the project itself.
        assert_eq!(project.properties["statuses"].as_array().unwrap().len(), 2);
        let type_note = entries
            .iter()
            .find(|e| e.path == "type/work-item.md")
            .unwrap();
        assert_eq!(type_note.properties["fields"]["status"]["kind"], "status");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn timestamps_are_iso_8601() {
        let vault = fixture_vault("scan-times");
        let entries = scan_vault(&vault).unwrap();
        for e in &entries {
            assert!(
                chrono::DateTime::parse_from_rfc3339(&e.created_at).is_ok(),
                "{}",
                e.created_at
            );
            assert!(
                chrono::DateTime::parse_from_rfc3339(&e.modified_at).is_ok(),
                "{}",
                e.modified_at
            );
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
        testutil::write(
            &vault,
            "projects/atlas/project.md",
            "---\ntype: Project\nkey: ATL\n---\n\n# Atlas\n",
        );
        testutil::write(
            &vault,
            "projects/atlas/items/atl-1.md",
            "---\ntype: Work item\n---\n\n# One\n",
        );
        testutil::write(&vault, "projects/atlas/meetings/kickoff.md", "# Kickoff\n");
        testutil::write(
            &vault,
            "projects/atlas/sub/project.md",
            "---\ntype: Project\n---\n\n# Sub\n",
        );
        testutil::write(&vault, "projects/atlas/sub/notes.md", "# Notes\n");
        testutil::write(&vault, "inbox/loose.md", "# Loose\n");
        let entries = scan_vault(&vault).unwrap();
        let get = |p: &str| entries.iter().find(|e| e.path == p).unwrap();
        assert_eq!(
            get("projects/atlas/items/atl-1.md").project.as_deref(),
            Some("projects/atlas/project.md")
        );
        assert_eq!(
            get("projects/atlas/items/atl-1.md").folder,
            "projects/atlas/items"
        );
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
        assert!(!dirs.iter().any(|d| d.starts_with("views")
            || d.starts_with(".obsidian")
            || d.starts_with("\u{200c}.notes")
            || d.starts_with("attachments")));
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
        assert!(bad
            .parse_error
            .as_deref()
            .unwrap()
            .starts_with("unreadable:"));
        assert_eq!(bad.title, "Bad");
        // The rest of the vault still scanned normally.
        assert!(entries
            .iter()
            .any(|e| e.path == "items/atl-1.md" && e.parse_error.is_none()));
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M55.2: the hash of bytes nobody read is not recorded, never the hash
    // of the empty string the entry was built from.
    #[test]
    fn an_unreadable_file_has_no_hash() {
        let vault = fixture_vault("scan-nohash");
        std::fs::write(vault.join("items/bad.md"), [0xFF, 0xFE, 0x00, 0x80]).unwrap();
        let entries = scan_vault(&vault).unwrap();
        let bad = entries.iter().find(|e| e.path == "items/bad.md").unwrap();
        assert!(bad.parse_error.is_some());
        assert_eq!(bad.hash, None);
        let good = entries.iter().find(|e| e.path == "items/atl-1.md").unwrap();
        let bytes = std::fs::read(vault.join("items/atl-1.md")).unwrap();
        assert_eq!(
            good.hash.as_deref(),
            Some(crate::ledger::sha256_hex(&bytes).as_str())
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// Notes the scan golden runs through `build_entry` beside the demo
    /// vault, as `(vault-relative path, content)`. A new parser edge case
    /// goes HERE, where the golden carries it to the TS replay — never as
    /// twin assertions written once in Rust and again in TS.
    const GOLDEN_FIXTURES: [(&str, &str); 5] = [
        ("boards/plan.canvas", include_str!("../../../shared/canvas/goldens/obsidian-layout.canvas")),
        ("boards/broken.canvas", "{\"nodes\":["),
        (
            "items/fld-7.md",
            "---\ntype: Work item\nkey: FLD-7\nstatus: progress\npriority: urgent\nproject: \"[[guided-onboarding-ga]]\"\n---\n\n# Checklist stalls on step 3 offline\n\nSteps to reproduce the stall, see [[offline-sync-hardening]].\n",
        ),
        (
            "items/broken.md",
            "---\ntype: [unclosed\nstatus: todo\n---\n\n# Broken note\n",
        ),
        (
            "notes/meeting-notes.md",
            "Just a plain paragraph that links to [[field-platform]].\n",
        ),
    ];

    const GOLDEN_REGEN: &str =
        "UPDATE_CONFORMANCE=1 cargo test --lib vault::scan::tests::scan_golden (from src-tauri/)";

    /// An Entry as the golden records it: every field but the timestamps,
    /// which are this checkout's file times rather than part of the corpus.
    /// `shift_remove`, because `preserve_order` is on and a plain `remove`
    /// would swap the last field into the hole.
    fn golden_entry(entry: &Entry) -> serde_json::Value {
        let mut value = serde_json::to_value(entry).unwrap();
        let fields = value.as_object_mut().unwrap();
        fields.shift_remove("createdAt");
        fields.shift_remove("modifiedAt");
        value
    }

    /// M53.22 — the scan golden, the parser's parity rail. Rust is the
    /// reference: under `UPDATE_CONFORMANCE` this writes
    /// `conformance/scan/entries.json`, and otherwise the committed bytes
    /// must equal regeneration. src/lib/scanGolden.test.ts replays the file
    /// against the mock backend's parser.
    #[test]
    fn scan_golden_is_committed_and_current() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let demo_vault = scan_vault(&root.join("demo-vault")).unwrap();
        let fixtures: Vec<serde_json::Value> = GOLDEN_FIXTURES
            .iter()
            .map(|(path, content)| {
                let entry = build_entry(path, content, String::new(), String::new());
                serde_json::json!({
                    "path": path,
                    "content": content,
                    "entry": golden_entry(&entry),
                })
            })
            .collect();
        let golden = serde_json::json!({
            "description": "Rust's scan of demo-vault/ and its build_entry over the fixtures, \
                            without createdAt/modifiedAt. Written by src-tauri/src/vault/scan.rs; \
                            replayed by src/lib/scanGolden.test.ts.",
            "demo_vault": demo_vault.iter().map(golden_entry).collect::<Vec<_>>(),
            "fixtures": fixtures,
        });
        let bytes = serde_json::to_string_pretty(&golden).unwrap() + "\n";
        let file = root.join("conformance/scan/entries.json");
        if std::env::var("UPDATE_CONFORMANCE").is_ok() {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, &bytes).unwrap();
            return;
        }
        let committed = std::fs::read_to_string(&file).unwrap_or_else(|_| {
            panic!("conformance/scan/entries.json is not committed: run {GOLDEN_REGEN}")
        });
        if committed != bytes {
            // The file runs to thousands of lines, so name the first line
            // that moved rather than printing both copies whole.
            let index = committed
                .lines()
                .zip(bytes.lines())
                .position(|(was, now)| was != now)
                .unwrap_or_else(|| committed.lines().count().min(bytes.lines().count()));
            let line = |text: &str| {
                let line = text.lines().nth(index);
                line.unwrap_or("(end of file)").to_string()
            };
            panic!(
                "conformance/scan/entries.json differs from regeneration at line {}:\n  \
                 committed:   {}\n  regenerated: {}\n\
                 A demo-vault or parser change must regenerate it: run {GOLDEN_REGEN}. \
                 An untracked file in demo-vault/ changes the scan too.",
                index + 1,
                line(&committed),
                line(&bytes),
            );
        }
    }
}
