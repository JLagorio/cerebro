//! Disk writes: frontmatter patching, note bodies, note creation, views.
//! All writes go through `write_file` so the watcher (Task 8) can register
//! own-writes for suppression in one place.

use std::path::Path;

use super::parse;

/// Raw saved-view file: `views/<id>.yml`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ViewYaml {
    pub id: String,
    pub yaml: String,
}

/// Single funnel for all vault file writes. Task 8 hooks the watcher's
/// own-write suppression in here.
fn write_file(abs: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(abs, content).map_err(|e| e.to_string())
}

fn read_file(vault: &Path, rel: &str) -> Result<String, String> {
    std::fs::read_to_string(vault.join(rel)).map_err(|e| format!("{rel}: {e}"))
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
    write_file(&vault.join(rel), &compose(new_block.as_deref(), body))
}

/// Replace the note body, preserving the frontmatter block byte-for-byte.
pub fn save_note(vault: &Path, rel: &str, body: &str) -> Result<(), String> {
    let content = read_file(vault, rel)?;
    let (block, _) = parse::split_frontmatter(&content);
    write_file(&vault.join(rel), &compose(block, body))
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

fn replace_h1(body: &str, title: &str) -> String {
    let h1_line = format!("# {title}");
    let mut lines: Vec<&str> = body.lines().collect();
    match lines.iter().position(|l| l.trim_start().starts_with("# ")) {
        Some(idx) => {
            lines[idx] = &h1_line;
            let mut out = lines.join("\n");
            if body.ends_with('\n') {
                out.push('\n');
            }
            out
        }
        None => format!("{h1_line}\n\n{body}"),
    }
}

/// Replace the first H1 line of the body, or insert one as the first line.
pub fn set_note_title(vault: &Path, rel: &str, title: &str) -> Result<(), String> {
    let content = read_file(vault, rel)?;
    let (block, body) = parse::split_frontmatter(&content);
    let new_body = replace_h1(body, title);
    write_file(&vault.join(rel), &compose(block, &new_body))
}

/// List `views/*.yml` as raw strings, sorted by id (filename stem).
pub fn list_views(vault: &Path) -> Result<Vec<ViewYaml>, String> {
    let dir = vault.join("views");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut views = Vec::new();
    for item in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let yaml = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        views.push(ViewYaml { id: id.to_string(), yaml });
    }
    views.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(views)
}

/// Write `views/<id>.yml` verbatim, creating `views/` if needed.
pub fn save_view(vault: &Path, id: &str, yaml: &str) -> Result<(), String> {
    write_file(&vault.join("views").join(format!("{id}.yml")), yaml)
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

    #[test]
    fn views_round_trip_as_raw_yaml() {
        let vault = testutil::temp_vault("wfm-views");
        assert!(list_views(&vault).unwrap().is_empty());
        save_view(&vault, "all-items", "name: All items\npresentation:\n  type: list\n").unwrap();
        save_view(&vault, "board", "name: Board\n").unwrap();
        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, "all-items");
        assert_eq!(views[0].yaml, "name: All items\npresentation:\n  type: list\n");
        assert_eq!(views[1].id, "board");
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
