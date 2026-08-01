//! The `Entry` record produced for every markdown file in the vault.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::parse;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub filename: String,
    /// Vault-relative parent directory ('' at the root) — vault format v2.
    pub folder: String,
    /// Owning `project.md` path via containment (nearest ancestor directory
    /// holding a project.md); None outside any project. Filled by the
    /// scanner's post-pass — a single file can't know this.
    pub project: Option<String>,
    pub title: String,
    #[serde(rename = "type")]
    pub entry_type: Option<String>,
    pub properties: serde_json::Map<String, serde_json::Value>,
    pub relationships: BTreeMap<String, Vec<String>>,
    pub outgoing_links: Vec<String>,
    pub snippet: String,
    pub created_at: String,
    pub modified_at: String,
    pub parse_error: Option<String>,
}

impl Entry {
    /// A bare Entry for unit tests that only exercise field-level logic.
    #[cfg(test)]
    pub fn empty_for_test(path: &str) -> Entry {
        Entry {
            path: path.to_string(),
            filename: path.rsplit('/').next().unwrap_or(path).to_string(),
            folder: path
                .rsplit_once('/')
                .map(|(d, _)| d)
                .unwrap_or("")
                .to_string(),
            project: None,
            title: "Untitled".into(),
            entry_type: None,
            properties: serde_json::Map::new(),
            relationships: BTreeMap::new(),
            outgoing_links: Vec::new(),
            snippet: String::new(),
            created_at: "2026-07-28T00:00:00Z".into(),
            modified_at: "2026-07-28T00:00:00Z".into(),
            parse_error: None,
        }
    }
}

/// Build an Entry from a vault-relative path (forward slashes) and raw file
/// content. Timestamps are passed in by the scanner (ISO 8601 strings).
pub fn build_entry(
    rel_path: &str,
    content: &str,
    created_at: String,
    modified_at: String,
) -> Entry {
    let filename = rel_path.rsplit('/').next().unwrap_or(rel_path).to_string();
    let folder = rel_path
        .rsplit_once('/')
        .map(|(d, _)| d)
        .unwrap_or("")
        .to_string();
    let stem = filename
        .strip_suffix(".md")
        .unwrap_or(&filename)
        .to_string();
    let (block, body) = parse::split_frontmatter(content);
    let (mapping, parse_error) = match block {
        Some(b) => match parse::parse_frontmatter(b) {
            Ok(m) => (m, None),
            Err(e) => (serde_yaml::Mapping::new(), Some(e)),
        },
        None => (serde_yaml::Mapping::new(), None),
    };

    let mut entry_type = None;
    let mut properties = serde_json::Map::new();
    let mut relationships = BTreeMap::new();
    for (key, value) in &mapping {
        let key = parse::yaml_key_string(key);
        if key == "type" {
            entry_type = value.as_str().map(str::to_string);
            continue;
        }
        let json = parse::yaml_to_json(value);
        match relationship_targets(&json) {
            Some(targets) => {
                relationships.insert(key, targets);
            }
            None => {
                properties.insert(key, json);
            }
        }
    }

    let title = parse::extract_h1_title(body).unwrap_or_else(|| parse::humanize_stem(&stem));

    Entry {
        path: rel_path.to_string(),
        filename,
        folder,
        project: None,
        title,
        entry_type,
        properties,
        relationships,
        outgoing_links: parse::extract_outgoing_links(body),
        snippet: parse::extract_snippet(body),
        created_at,
        modified_at,
        parse_error,
    }
}

/// A frontmatter value is a relationship when its string content contains at
/// least one wikilink; returns the targets, or None for a plain value.
fn relationship_targets(value: &serde_json::Value) -> Option<Vec<String>> {
    let mut targets = Vec::new();
    collect_targets(value, &mut targets);
    if targets.is_empty() {
        None
    } else {
        Some(targets)
    }
}

fn collect_targets(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => out.extend(parse::wikilink_targets(s)),
        serde_json::Value::Array(items) => items.iter().for_each(|i| collect_targets(i, out)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREATED: &str = "2026-07-24T10:00:00Z";
    const MODIFIED: &str = "2026-07-24T11:00:00Z";

    fn build(path: &str, content: &str) -> Entry {
        build_entry(path, content, CREATED.to_string(), MODIFIED.to_string())
    }

    #[test]
    fn extracts_full_entry_from_valid_note() {
        let content = "---\ntype: Work item\nkey: ATL-1\nstatus: in-progress\ntags:\n  - engine\n  - parser\nestimate: 3\nproject: \"[[atlas]]\"\n---\n\n# Fix the parser\n\nBody links [[atlas]] and [[maya-chen|Maya]].\n";
        let e = build("items/atl-1.md", content);
        assert_eq!(e.path, "items/atl-1.md");
        assert_eq!(e.filename, "atl-1.md");
        assert_eq!(e.title, "Fix the parser");
        assert_eq!(e.entry_type.as_deref(), Some("Work item"));
        assert_eq!(e.properties["key"], "ATL-1");
        assert_eq!(e.properties["status"], "in-progress");
        assert_eq!(
            e.properties["tags"],
            serde_json::json!(["engine", "parser"])
        );
        assert_eq!(e.properties["estimate"], 3);
        assert!(!e.properties.contains_key("project"));
        assert_eq!(e.relationships["project"], vec!["atlas"]);
        assert_eq!(e.outgoing_links, vec!["atlas", "maya-chen"]);
        assert!(e.snippet.starts_with("Body links atlas and Maya."));
        assert_eq!(e.created_at, CREATED);
        assert_eq!(e.modified_at, MODIFIED);
        assert!(e.parse_error.is_none());
    }

    #[test]
    fn wikilink_arrays_become_relationships() {
        let content =
            "---\nmembers:\n  - \"[[maya-chen]]\"\n  - \"[[joss-b|Joss]]\"\n---\n\n# Team\n";
        let e = build("people/team.md", content);
        assert_eq!(e.relationships["members"], vec!["maya-chen", "joss-b"]);
        assert!(!e.properties.contains_key("members"));
    }

    #[test]
    fn arrays_stay_arrays_even_with_one_item() {
        // Simplification vs Tolaria: no single-item → scalar normalization.
        let content = "---\ntags:\n  - solo\n---\n\n# One tag\n";
        let e = build("items/x.md", content);
        assert_eq!(e.properties["tags"], serde_json::json!(["solo"]));
    }

    #[test]
    fn nested_mappings_are_kept_in_properties() {
        // Type notes carry `fields:` mappings; space notes carry `statuses:`
        // arrays of mappings. Both must survive into properties as JSON so
        // the TS schema engine can read them.
        let content = "---\ntype: Type\nfields:\n  status: { kind: status }\n  due: { kind: date }\n---\n\n# Work item\n";
        let e = build("type/work-item.md", content);
        assert_eq!(e.properties["fields"]["status"]["kind"], "status");
        assert_eq!(e.properties["fields"]["due"]["kind"], "date");
    }

    #[test]
    fn malformed_yaml_sets_parse_error_with_empty_maps() {
        let content = "---\nstatus: [unclosed\n---\n\n# Broken\n";
        let e = build("items/broken.md", content);
        assert!(e.parse_error.is_some());
        assert!(e.properties.is_empty());
        assert!(e.relationships.is_empty());
        assert_eq!(e.entry_type, None);
        assert_eq!(e.title, "Broken");
    }

    #[test]
    fn missing_h1_falls_back_to_humanized_stem() {
        let content = "---\ntype: Work item\n---\n\nJust prose, no heading.\n";
        let e = build("items/fix-login-flow.md", content);
        assert_eq!(e.title, "Fix login flow");
    }

    #[test]
    fn crlf_file_extracts_type_and_title() {
        let content = "---\r\ntype: Work item\r\nstatus: todo\r\n---\r\n\r\n# CRLF title\r\n\r\nBody line with [[atlas]].\r\n";
        let e = build("items/crlf.md", content);
        assert_eq!(e.entry_type.as_deref(), Some("Work item"));
        assert_eq!(e.properties["status"], "todo");
        assert_eq!(e.title, "CRLF title");
        assert_eq!(e.outgoing_links, vec!["atlas"]);
        assert!(e.parse_error.is_none());
    }

    #[test]
    fn serializes_to_camel_case_json() {
        let e = build("items/x.md", "# X\n");
        let json = serde_json::to_value(&e).unwrap();
        assert!(json.get("outgoingLinks").is_some());
        assert!(json.get("createdAt").is_some());
        assert!(json.get("modifiedAt").is_some());
        assert!(json.get("parseError").is_some());
        assert!(json.get("type").is_some());
    }

    // CROSS-LANGUAGE PARITY FIXTURES
    // These three fixture strings are also asserted by the TS mock parser
    // tests in src/lib/mockParse.test.ts (Task 10). If a fixture or an
    // expected value changes here it must change there too: the mock parser
    // and the Rust scanner must produce the same Entry for the same content.

    const FIXTURE_ITEM: &str = "---\ntype: Work item\nkey: FLD-7\nstatus: progress\npriority: urgent\nproject: \"[[guided-onboarding-ga]]\"\n---\n\n# Checklist stalls on step 3 offline\n\nSteps to reproduce the stall, see [[offline-sync-hardening]].\n";

    const FIXTURE_BAD_YAML: &str = "---\ntype: [unclosed\nstatus: todo\n---\n\n# Broken note\n";

    const FIXTURE_PLAIN: &str = "Just a plain paragraph that links to [[field-platform]].\n";

    #[test]
    fn parity_fixture_1_full_item() {
        let e = build("items/fld-7.md", FIXTURE_ITEM);
        assert_eq!(e.path, "items/fld-7.md");
        assert_eq!(e.filename, "fld-7.md");
        assert_eq!(e.title, "Checklist stalls on step 3 offline");
        assert_eq!(e.entry_type.as_deref(), Some("Work item"));
        assert_eq!(e.properties["key"], "FLD-7");
        assert_eq!(e.properties["status"], "progress");
        assert_eq!(e.properties["priority"], "urgent");
        assert!(!e.properties.contains_key("project"));
        assert_eq!(e.relationships["project"], vec!["guided-onboarding-ga"]);
        assert_eq!(e.outgoing_links, vec!["offline-sync-hardening"]);
        assert_eq!(
            e.snippet,
            "Steps to reproduce the stall, see offline-sync-hardening."
        );
        assert!(e.parse_error.is_none());
    }

    #[test]
    fn parity_fixture_2_malformed_yaml() {
        let e = build("items/broken.md", FIXTURE_BAD_YAML);
        assert!(e.parse_error.is_some());
        assert!(e.properties.is_empty());
        assert!(e.relationships.is_empty());
        assert_eq!(e.entry_type, None);
        assert_eq!(e.title, "Broken note");
    }

    #[test]
    fn parity_fixture_3_plain_note() {
        let e = build("notes/meeting-notes.md", FIXTURE_PLAIN);
        assert_eq!(e.title, "Meeting notes");
        assert_eq!(e.entry_type, None);
        assert!(e.properties.is_empty());
        assert_eq!(e.outgoing_links, vec!["field-platform"]);
        assert_eq!(
            e.snippet,
            "Just a plain paragraph that links to field-platform."
        );
        assert!(e.parse_error.is_none());
    }
}
