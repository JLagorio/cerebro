//! Disk writes: frontmatter patching, note bodies, note creation, views.
//! All writes go through `write_file` so the watcher (Task 8) can register
//! own-writes for suppression in one place. All caller-supplied paths are
//! validated by `safe_join`/`safe_component` — Task 7 exposes these functions
//! over IPC, so vault containment is enforced here, not in the callers.

use std::path::{Component, Path, PathBuf};

use super::parse;

/// Raw saved-view file: `views/<id>.yml` at the vault root (project None) or
/// `<project dir>/views/<id>.yml` (project = that dir's project.md path).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ViewYaml {
    pub id: String,
    pub yaml: String,
    pub project: Option<String>,
}

/// Single funnel for all vault file writes; registers each write with the
/// watcher so our own saves don't bounce back as `vault-changed` events.
fn write_file(abs: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(abs, content).map_err(|e| e.to_string())?;
    super::watcher::note_own_write(abs);
    Ok(())
}

/// Join a vault-relative path onto the vault root, rejecting empty paths,
/// absolute paths (`Path::join` would replace the base!), and any `..`
/// traversal, so no read or write can escape the vault.
fn safe_join(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let contained = !rel.is_empty()
        && Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if contained {
        Ok(vault.join(rel))
    } else {
        Err(format!("path escapes the vault: {rel:?}"))
    }
}

/// Require a single normal path component: non-empty, no separators, no
/// traversal. Used for note slugs and view ids.
fn safe_component(kind: &str, value: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    let single_normal = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    );
    if single_normal && !value.contains(['/', '\\']) {
        Ok(())
    } else {
        Err(format!("invalid {kind}: {value:?}"))
    }
}

fn read_file(vault: &Path, rel: &str) -> Result<String, String> {
    std::fs::read_to_string(safe_join(vault, rel)?).map_err(|e| format!("{rel}: {e}"))
}

/// Recompose a file from a raw frontmatter block (with trailing newline) and
/// an untouched body. Empty/absent block → body only.
fn compose(block: Option<&str>, body: &str) -> String {
    match block {
        Some(b) if !b.trim().is_empty() => format!("---\n{b}---\n{body}"),
        _ => body.to_string(),
    }
}

fn serialize_mapping(mapping: &serde_yaml::Mapping) -> Result<Option<String>, String> {
    if mapping.is_empty() {
        return Ok(None);
    }
    serde_yaml::to_string(mapping).map(Some).map_err(|e| e.to_string())
}

/// Convert a JSON patch value to YAML for insertion into a mapping.
fn json_to_yaml(value: &serde_json::Value) -> serde_yaml::Value {
    match value {
        serde_json::Value::Null => serde_yaml::Value::Null,
        serde_json::Value::Bool(b) => serde_yaml::Value::Bool(*b),
        serde_json::Value::Number(n) => {
            serde_yaml::from_str(&n.to_string()).unwrap_or(serde_yaml::Value::Null)
        }
        serde_json::Value::String(s) => serde_yaml::Value::String(s.clone()),
        serde_json::Value::Array(items) => {
            serde_yaml::Value::Sequence(items.iter().map(json_to_yaml).collect())
        }
        serde_json::Value::Object(map) => {
            let mut m = serde_yaml::Mapping::new();
            for (k, v) in map {
                m.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
            }
            serde_yaml::Value::Mapping(m)
        }
    }
}

/// Apply a JSON patch to a note's frontmatter. `null` deletes a key; existing
/// keys keep their position; new keys append; unknown keys and the body are
/// untouched.
///
/// CRLF/BOM/trailing-whitespace-fence files (see the round-trip caveat at the
/// top of parse.rs) are normalized: the frontmatter block is reserialized and
/// the fences rewritten in LF form. The body is preserved byte-for-byte.
/// YAML comments and the original scalar quoting style inside the frontmatter
/// block are not preserved through reserialization.
pub fn update_frontmatter(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let content = read_file(vault, rel)?;
    let (block, body) = parse::split_frontmatter(&content);
    let mut mapping = match block {
        Some(b) => parse::parse_frontmatter(b)
            .map_err(|e| format!("{rel}: cannot patch malformed frontmatter: {e}"))?,
        None => serde_yaml::Mapping::new(),
    };
    for (key, value) in patch {
        let key = serde_yaml::Value::String(key.clone());
        if value.is_null() {
            mapping.shift_remove(&key); // shift_remove preserves key order
        } else {
            mapping.insert(key, json_to_yaml(value)); // existing keys keep position
        }
    }
    let new_block = serialize_mapping(&mapping)?;
    write_file(&safe_join(vault, rel)?, &compose(new_block.as_deref(), body))
}

/// Replace the note body, preserving the frontmatter block byte-for-byte.
pub fn save_note(vault: &Path, rel: &str, body: &str) -> Result<(), String> {
    let content = read_file(vault, rel)?;
    let (block, _) = parse::split_frontmatter(&content);
    write_file(&safe_join(vault, rel)?, &compose(block, body))
}

/// Return the note body only (frontmatter stripped).
pub fn read_note(vault: &Path, rel: &str) -> Result<String, String> {
    let content = read_file(vault, rel)?;
    let (_, body) = parse::split_frontmatter(&content);
    Ok(body.to_string())
}

fn unique_rel_path(vault: &Path, folder: &str, slug: &str) -> String {
    let first = format!("{folder}/{slug}.md");
    if !vault.join(&first).exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{folder}/{slug}-{n}.md");
        if !vault.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Create `<folder>/<slug>.md` (deduping to `-2`, `-3`, …) with the given
/// frontmatter and body; empty body gets a humanized `# Title` line.
/// Returns the vault-relative path.
pub fn create_note(
    vault: &Path,
    folder: &str,
    slug: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<String, String> {
    safe_join(vault, folder)?; // folder must stay inside the vault
    safe_component("slug", slug)?;
    let rel = unique_rel_path(vault, folder, slug);
    let mut mapping = serde_yaml::Mapping::new();
    for (k, v) in frontmatter {
        if v.is_null() {
            continue;
        }
        mapping.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
    }
    let block = serialize_mapping(&mapping)?;
    let body = if body.trim().is_empty() {
        format!("# {}\n", parse::humanize_stem(slug))
    } else {
        body.to_string()
    };
    let content = match block {
        Some(b) => format!("---\n{b}---\n\n{body}"),
        None => body,
    };
    write_file(&vault.join(&rel), &content)?;
    Ok(rel)
}

/// Replace the H1 line that `parse::extract_h1_title` would read the title
/// from (fenced/indented code lines are never the H1), or prepend one when
/// the body has no real H1. Only the H1 line itself is spliced; every other
/// byte of the body (including CRLF line endings) is preserved.
fn replace_h1(body: &str, title: &str) -> String {
    let h1_line = format!("# {title}");
    match parse::first_h1_line_start(body) {
        Some(start) => {
            let rest = &body[start..];
            // End of the H1 text, excluding the line terminator (LF or CRLF).
            let end = match rest.find('\n') {
                Some(i) if rest[..i].ends_with('\r') => start + i - 1,
                Some(i) => start + i,
                None => body.len(),
            };
            format!("{}{h1_line}{}", &body[..start], &body[end..])
        }
        None => format!("{h1_line}\n\n{body}"),
    }
}

/// Replace the first H1 line of the body, or insert one as the first line.
pub fn set_note_title(vault: &Path, rel: &str, title: &str) -> Result<(), String> {
    let content = read_file(vault, rel)?;
    let (block, body) = parse::split_frontmatter(&content);
    let new_body = replace_h1(body, title);
    write_file(&safe_join(vault, rel)?, &compose(block, &new_body))
}

fn collect_views_dir(
    dir: &Path,
    project: Option<&str>,
    views: &mut Vec<ViewYaml>,
) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for item in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let yaml = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        views.push(ViewYaml {
            id: id.to_string(),
            yaml,
            project: project.map(str::to_string),
        });
    }
    Ok(())
}

/// List saved views: `views/*.yml` at the vault root (global) plus each
/// project folder's `views/*.yml` (M2 Task 6). Sorted by (project, id).
pub fn list_views(vault: &Path) -> Result<Vec<ViewYaml>, String> {
    let mut views = Vec::new();
    collect_views_dir(&vault.join("views"), None, &mut views)?;
    // Project views: a views/ dir next to any project.md. Reuse the scanner's
    // walk semantics (skips dot/views/attachments dirs) to find project docs.
    let walker = walkdir::WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || e.file_type().is_file()
                || !{
                    let name = e.file_name().to_string_lossy();
                    name.starts_with('.') || name == "views" || name == "attachments"
                }
        });
    for item in walker {
        let Ok(item) = item else { continue };
        if !item.file_type().is_file() || item.file_name().to_string_lossy() != "project.md" {
            continue;
        }
        let Some(project_dir) = item.path().parent() else { continue };
        let rel_project = item
            .path()
            .strip_prefix(vault)
            .map_err(|e| e.to_string())?
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        collect_views_dir(&project_dir.join("views"), Some(&rel_project), &mut views)?;
    }
    views.sort_by(|a, b| a.project.cmp(&b.project).then(a.id.cmp(&b.id)));
    Ok(views)
}

/// Write `<folder>/views/<id>.yml` verbatim (vault-root `views/` when folder
/// is None), creating the directory if needed.
pub fn save_view(vault: &Path, id: &str, yaml: &str, folder: Option<&str>) -> Result<(), String> {
    safe_component("view id", id)?;
    let base = match folder {
        Some(f) => safe_join(vault, f)?,
        None => vault.to_path_buf(),
    };
    write_file(&base.join("views").join(format!("{id}.yml")), yaml)
}

// --- Vault format v2 file operations (M2 Task 3) ---

/// Create a directory (and parents) inside the vault.
pub fn create_folder(vault: &Path, rel: &str) -> Result<(), String> {
    let abs = safe_join(vault, rel)?;
    std::fs::create_dir_all(&abs).map_err(|e| e.to_string())
}

/// Move a note — or a whole folder — within the vault. Refuses to clobber an
/// existing target. Both paths register as own-writes so the watcher doesn't
/// bounce our move back as external changes.
pub fn rename_note(vault: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = safe_join(vault, from)?;
    let dst = safe_join(vault, to)?;
    if dst.exists() {
        return Err(format!("target already exists: {to}"));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("{from}: {e}"))?;
    super::watcher::note_own_write(&src);
    super::watcher::note_own_write(&dst);
    Ok(())
}

/// Move a note or folder to the OS trash — user markdown is never
/// hard-deleted.
pub fn delete_note(vault: &Path, rel: &str) -> Result<(), String> {
    let abs = safe_join(vault, rel)?;
    if !abs.exists() {
        return Err(format!("not found: {rel}"));
    }
    trash::delete(&abs).map_err(|e| e.to_string())?;
    super::watcher::note_own_write(&abs);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    const NOTE: &str = "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n";

    fn vault_with_note(label: &str) -> std::path::PathBuf {
        let vault = testutil::temp_vault(label);
        testutil::write(&vault, "items/atl-1.md", NOTE);
        vault
    }

    fn read(vault: &Path, rel: &str) -> String {
        std::fs::read_to_string(vault.join(rel)).unwrap()
    }

    fn patch(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs.iter().cloned().map(|(k, v)| (k.to_string(), v)).collect()
    }

    #[test]
    fn update_preserves_order_and_unknown_keys_byte_for_byte() {
        let vault = vault_with_note("wfm-update");
        update_frontmatter(&vault, "items/atl-1.md", &patch(&[("status", serde_json::json!("done"))]))
            .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: done\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn null_patch_value_deletes_the_key_preserving_order() {
        let vault = vault_with_note("wfm-delete");
        update_frontmatter(&vault, "items/atl-1.md", &patch(&[("key", serde_json::Value::Null)]))
            .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn new_keys_are_appended_at_the_end() {
        let vault = vault_with_note("wfm-append");
        update_frontmatter(&vault, "items/atl-1.md", &patch(&[("due", serde_json::json!("2026-08-01"))]))
            .unwrap();
        let raw = read(&vault, "items/atl-1.md");
        assert!(raw.contains("custom_field: kept\ndue: 2026-08-01\n---\n"), "{raw}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // split_frontmatter's byte-reproduction invariant only holds for LF-only,
    // BOM-free files with a bare `---` closing fence (parse.rs:9-15). Writes
    // may normalize fences to LF form but must never corrupt such files.
    #[test]
    fn update_normalizes_crlf_fences_without_corrupting_the_file() {
        let vault = testutil::temp_vault("wfm-crlf");
        testutil::write(
            &vault,
            "items/crlf.md",
            "---\r\ntype: Work item\r\nstatus: todo\r\n---\r\n\r\n# Crlf note\r\n\r\nBody stays.\r\n",
        );
        update_frontmatter(&vault, "items/crlf.md", &patch(&[("status", serde_json::json!("done"))]))
            .unwrap();
        let raw = read(&vault, "items/crlf.md");
        // No duplicated or dropped fences.
        assert_eq!(raw.matches("---").count(), 2, "{raw}");
        // Frontmatter survives the patch (fences may be normalized to LF).
        let (block, body) = parse::split_frontmatter(&raw);
        let mapping = parse::parse_frontmatter(block.expect("frontmatter kept")).unwrap();
        assert_eq!(mapping.get("type").and_then(|v| v.as_str()), Some("Work item"));
        assert_eq!(mapping.get("status").and_then(|v| v.as_str()), Some("done"));
        // Body is untouched.
        assert_eq!(body, "\r\n# Crlf note\r\n\r\nBody stays.\r\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn save_note_replaces_body_and_keeps_frontmatter_bytes() {
        let vault = vault_with_note("wfm-save");
        save_note(&vault, "items/atl-1.md", "\n# Ship the scanner\n\nNew body.\n").unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nNew body.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn read_note_returns_body_only() {
        let vault = vault_with_note("wfm-read");
        assert_eq!(
            read_note(&vault, "items/atl-1.md").unwrap(),
            "\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_writes_frontmatter_and_dedupes_slug() {
        let vault = testutil::temp_vault("wfm-create");
        let fm = patch(&[
            ("type", serde_json::json!("Work item")),
            ("status", serde_json::json!("todo")),
        ]);
        let first = create_note(&vault, "items", "new-item", &fm, "# New item\n").unwrap();
        let second = create_note(&vault, "items", "new-item", &fm, "# New item\n").unwrap();
        let third = create_note(&vault, "items", "new-item", &fm, "# New item\n").unwrap();
        assert_eq!(first, "items/new-item.md");
        assert_eq!(second, "items/new-item-2.md");
        assert_eq!(third, "items/new-item-3.md");
        assert_eq!(
            read(&vault, "items/new-item.md"),
            "---\ntype: Work item\nstatus: todo\n---\n\n# New item\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_with_empty_body_gets_default_h1() {
        let vault = testutil::temp_vault("wfm-create-empty");
        create_note(&vault, "items", "empty-note", &patch(&[]), "").unwrap();
        // Sentence case per humanize_stem (mockParse.ts parity).
        assert_eq!(read(&vault, "items/empty-note.md"), "# Empty note\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_replaces_existing_h1() {
        let vault = vault_with_note("wfm-title");
        set_note_title(&vault, "items/atl-1.md", "Renamed item").unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Renamed item\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_inserts_h1_when_missing() {
        let vault = testutil::temp_vault("wfm-title-insert");
        testutil::write(&vault, "items/no-title.md", "Just prose.\n");
        set_note_title(&vault, "items/no-title.md", "Now titled").unwrap();
        assert_eq!(read(&vault, "items/no-title.md"), "# Now titled\n\nJust prose.\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // set_note_title must agree with parse::extract_h1_title about which line
    // is the H1: fenced/indented code lines are never the title.
    #[test]
    fn set_note_title_skips_h1_inside_code_fences() {
        let vault = testutil::temp_vault("wfm-title-fence");
        testutil::write(
            &vault,
            "items/fenced.md",
            "---\ntype: Work item\n---\n\nintro\n\n```bash\n# a comment in code\necho hi\n```\n\n# Real title\n\nBody stays.\n",
        );
        set_note_title(&vault, "items/fenced.md", "Renamed").unwrap();
        assert_eq!(
            read(&vault, "items/fenced.md"),
            "---\ntype: Work item\n---\n\nintro\n\n```bash\n# a comment in code\necho hi\n```\n\n# Renamed\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_prepends_h1_when_only_fenced_h1_exists() {
        let vault = testutil::temp_vault("wfm-title-fence-only");
        testutil::write(&vault, "items/code.md", "```\n# only in code\n```\n");
        set_note_title(&vault, "items/code.md", "Now titled").unwrap();
        assert_eq!(read(&vault, "items/code.md"), "# Now titled\n\n```\n# only in code\n```\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_preserves_crlf_body_bytes_outside_the_h1_line() {
        let vault = testutil::temp_vault("wfm-title-crlf");
        testutil::write(&vault, "items/crlf-title.md", "# Old title\r\n\r\nBody stays.\r\n");
        set_note_title(&vault, "items/crlf-title.md", "New title").unwrap();
        assert_eq!(read(&vault, "items/crlf-title.md"), "# New title\r\n\r\nBody stays.\r\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn views_round_trip_as_raw_yaml() {
        let vault = testutil::temp_vault("wfm-views");
        assert!(list_views(&vault).unwrap().is_empty());
        save_view(&vault, "all-items", "name: All items\npresentation:\n  type: list\n", None)
            .unwrap();
        save_view(&vault, "board", "name: Board\n", None).unwrap();
        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, "all-items");
        assert_eq!(views[0].yaml, "name: All items\npresentation:\n  type: list\n");
        assert_eq!(views[0].project, None);
        assert_eq!(views[1].id, "board");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M2 Task 6: views/ dirs inside project folders are project-scoped.
    #[test]
    fn project_views_carry_their_project_and_sort_after_globals() {
        let vault = testutil::temp_vault("wfm-project-views");
        testutil::write(&vault, "projects/atlas/project.md", "---\ntype: Project\n---\n\n# Atlas\n");
        save_view(&vault, "global", "name: Global\n", None).unwrap();
        save_view(&vault, "delivery", "name: Delivery\n", Some("projects/atlas")).unwrap();
        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, "global");
        assert_eq!(views[0].project, None);
        assert_eq!(views[1].id, "delivery");
        assert_eq!(views[1].project.as_deref(), Some("projects/atlas/project.md"));
        assert!(vault.join("projects/atlas/views/delivery.yml").is_file());
        // Escaping folders are rejected.
        assert!(save_view(&vault, "evil", "name: E\n", Some("../outside")).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Containment: rel paths, folders, slugs, and view ids reach Tauri IPC
    // unchanged (Task 7), so escapes must be rejected here.
    #[test]
    fn writes_reject_paths_that_escape_the_vault() {
        let vault = vault_with_note("wfm-escape");
        // A real file one level above the vault root: without containment,
        // "../<name>" reaches and modifies it.
        let victim = vault.parent().unwrap().join(format!("cerebro-victim-{}.md", std::process::id()));
        const VICTIM: &str = "---\nsafe: true\n---\nUntouched.\n";
        std::fs::write(&victim, VICTIM).unwrap();
        let victim_rel = format!("../{}", victim.file_name().unwrap().to_str().unwrap());
        let hacked = patch(&[("hacked", serde_json::json!(true))]);

        assert!(update_frontmatter(&vault, &victim_rel, &hacked).is_err());
        assert!(save_note(&vault, &victim_rel, "hacked\n").is_err());
        assert!(set_note_title(&vault, &victim_rel, "Hacked").is_err());
        assert!(read_note(&vault, &victim_rel).is_err());
        // Absolute paths must be rejected too: Path::join replaces the base.
        let abs = victim.to_str().unwrap();
        assert!(update_frontmatter(&vault, abs, &hacked).is_err());
        assert!(read_note(&vault, abs).is_err());
        // Traversal buried mid-path is still traversal.
        assert!(read_note(&vault, "items/../../x.md").is_err());

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), VICTIM);
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_rejects_escaping_folder_and_non_component_slug() {
        let vault = testutil::temp_vault("wfm-create-escape");
        let fm = patch(&[]);
        assert!(create_note(&vault, "../escaped", "note", &fm, "x\n").is_err());
        assert!(create_note(&vault, "/tmp", "note", &fm, "x\n").is_err());
        assert!(create_note(&vault, "items", "../sneaky", &fm, "x\n").is_err());
        assert!(create_note(&vault, "items", "a/../b", &fm, "x\n").is_err());
        assert!(create_note(&vault, "items", "a/b", &fm, "x\n").is_err());
        assert!(create_note(&vault, "items", "", &fm, "x\n").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn save_view_rejects_non_component_ids() {
        let vault = testutil::temp_vault("wfm-view-escape");
        assert!(save_view(&vault, "../../evil-view", "name: Evil\n", None).is_err());
        assert!(save_view(&vault, "nested/id", "name: Evil\n", None).is_err());
        assert!(save_view(&vault, "", "name: Evil\n", None).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_folder_and_rename_note_move_notes_and_folders_within_the_vault() {
        let vault = vault_with_note("wfm-rename");
        create_folder(&vault, "projects/atlas/items").unwrap();
        assert!(vault.join("projects/atlas/items").is_dir());
        rename_note(&vault, "items/atl-1.md", "projects/atlas/items/atl-1.md").unwrap();
        assert!(!vault.join("items/atl-1.md").exists());
        assert_eq!(read(&vault, "projects/atlas/items/atl-1.md"), NOTE);
        // Refuses to clobber an existing target.
        testutil::write(&vault, "items/atl-2.md", NOTE);
        assert!(rename_note(&vault, "items/atl-2.md", "projects/atlas/items/atl-1.md").is_err());
        // Whole folders move too.
        rename_note(&vault, "items", "archive").unwrap();
        assert_eq!(read(&vault, "archive/atl-2.md"), NOTE);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // delete_note's happy path routes through the OS trash (trash::delete) —
    // exercised manually in the tauri-dev shakeout rather than polluting the
    // developer's Trash on every test run. Guards are covered here.
    #[test]
    fn v2_ops_reject_escapes_and_missing_paths() {
        let vault = vault_with_note("wfm-v2-escape");
        assert!(create_folder(&vault, "../evil").is_err());
        assert!(create_folder(&vault, "/tmp/evil").is_err());
        assert!(rename_note(&vault, "items/atl-1.md", "../stolen.md").is_err());
        assert!(rename_note(&vault, "../victim.md", "items/x.md").is_err());
        assert!(rename_note(&vault, "items/nope.md", "items/still-nope.md").is_err());
        assert!(delete_note(&vault, "../victim.md").is_err());
        assert!(delete_note(&vault, "items/nope.md").is_err());
        // The escape attempts must not have touched the real note.
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn update_survives_trailing_whitespace_closing_fence() {
        let vault = testutil::temp_vault("wfm-fence-ws");
        testutil::write(
            &vault,
            "items/ws.md",
            "---\ntype: Work item\nstatus: todo\n--- \nBody stays.\n",
        );
        update_frontmatter(&vault, "items/ws.md", &patch(&[("status", serde_json::json!("done"))]))
            .unwrap();
        assert_eq!(
            read(&vault, "items/ws.md"),
            "---\ntype: Work item\nstatus: done\n---\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }
}
