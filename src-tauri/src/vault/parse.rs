//! Frontmatter splitting, YAML parsing, and markdown text helpers.

/// Split raw file content into (frontmatter block, body).
///
/// The block is the raw text between the opening `---` fence and the closing
/// fence line, including its trailing newline. The body is everything after
/// the closing fence line (one newline after the fence is consumed), so
/// `format!("---\n{block}---\n{body}")` reproduces the original bytes.
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    else {
        return (None, content);
    };
    if let Some(body) = rest.strip_prefix("---\n") {
        return (Some(""), body);
    }
    let mut search = 0;
    while let Some(pos) = rest[search..].find("\n---") {
        let idx = search + pos;
        let after = &rest[idx + 4..];
        if after.is_empty() || after.starts_with('\n') || after.starts_with("\r\n") {
            let block = &rest[..idx + 1];
            let body = after
                .strip_prefix("\r\n")
                .or_else(|| after.strip_prefix('\n'))
                .unwrap_or(after);
            return (Some(block), body);
        }
        search = idx + 1;
    }
    (None, content)
}

/// Parse a frontmatter block into a YAML mapping. Empty block → empty
/// mapping. Malformed YAML or non-mapping YAML → Err with the message.
pub fn parse_frontmatter(block: &str) -> Result<serde_yaml::Mapping, String> {
    if block.trim().is_empty() {
        return Ok(serde_yaml::Mapping::new());
    }
    let value: serde_yaml::Value = serde_yaml::from_str(block).map_err(|e| e.to_string())?;
    match value {
        serde_yaml::Value::Mapping(m) => Ok(m),
        serde_yaml::Value::Null => Ok(serde_yaml::Mapping::new()),
        _ => Err("frontmatter is not a mapping".to_string()),
    }
}

/// All wikilink targets in a string: `[[target]]` and `[[target|alias]]`.
pub fn wikilink_targets(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let inner_start = start + 2;
        let Some(end_rel) = rest[inner_start..].find("]]") else {
            break;
        };
        let inner = &rest[inner_start..inner_start + end_rel];
        let target = inner.split('|').next().unwrap_or("").trim();
        if !target.is_empty() && !target.contains('[') && !target.contains(']') {
            out.push(target.to_string());
        }
        rest = &rest[inner_start + end_rel + 2..];
    }
    out
}

/// Wikilink targets in a note body, deduplicated preserving first-seen order.
pub fn extract_outgoing_links(body: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    wikilink_targets(body)
        .into_iter()
        .filter(|t| seen.insert(t.clone()))
        .collect()
}

/// Text of the first H1 (`# ...`) line anywhere in the body.
pub fn extract_h1_title(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        line.trim()
            .strip_prefix("# ")
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
    })
}

/// Humanize a filename stem: `fix-login-flow` → `Fix login flow`.
/// Sentence case — parity with `humanize` in `src/lib/mockParse.ts`.
pub fn humanize_stem(stem: &str) -> String {
    let spaced = stem
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if spaced.is_empty() {
        return stem.to_string();
    }
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// First 160 chars of the body with markdown syntax roughly stripped.
pub fn extract_snippet(body: &str) -> String {
    let text: String = body
        .lines()
        .map(str::trim)
        .filter(|l| {
            !l.is_empty() && !l.starts_with('#') && !l.starts_with("```") && !l.starts_with("---")
        })
        .map(strip_inline_markdown)
        .collect::<Vec<_>>()
        .join(" ");
    text.trim().chars().take(160).collect()
}

/// Strip list markers, emphasis chars, and unwrap wikilinks to display text.
fn strip_inline_markdown(line: &str) -> String {
    let line = line.trim_start_matches(['-', '*', '+', '>']).trim_start();
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let inner_start = start + 2;
        match rest[inner_start..].find("]]") {
            Some(end_rel) => {
                let inner = &rest[inner_start..inner_start + end_rel];
                let display = inner.split('|').next_back().unwrap_or(inner);
                out.push_str(display);
                rest = &rest[inner_start + end_rel + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out.chars().filter(|c| !matches!(c, '*' | '_' | '`')).collect()
}

/// Convert a YAML value to a JSON value (tagged values unwrapped,
/// non-string mapping keys stringified).
pub fn yaml_to_json(value: &serde_yaml::Value) -> serde_json::Value {
    match value {
        serde_yaml::Value::Null => serde_json::Value::Null,
        serde_yaml::Value::Bool(b) => serde_json::Value::Bool(*b),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_json::Value::from(i)
            } else if let Some(u) = n.as_u64() {
                serde_json::Value::from(u)
            } else {
                n.as_f64().map(serde_json::Value::from).unwrap_or(serde_json::Value::Null)
            }
        }
        serde_yaml::Value::String(s) => serde_json::Value::String(s.clone()),
        serde_yaml::Value::Sequence(seq) => {
            serde_json::Value::Array(seq.iter().map(yaml_to_json).collect())
        }
        serde_yaml::Value::Mapping(map) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in map {
                obj.insert(yaml_key_string(k), yaml_to_json(v));
            }
            serde_json::Value::Object(obj)
        }
        serde_yaml::Value::Tagged(t) => yaml_to_json(&t.value),
    }
}

/// Render a YAML mapping key as a plain string.
pub fn yaml_key_string(key: &serde_yaml::Value) -> String {
    match key {
        serde_yaml::Value::String(s) => s.clone(),
        other => serde_yaml::to_string(other)
            .map(|s| s.trim_end().to_string())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_frontmatter_and_body() {
        let content = "---\ntype: Work item\nstatus: todo\n---\n\n# Title\n\nBody.\n";
        let (block, body) = split_frontmatter(content);
        assert_eq!(block, Some("type: Work item\nstatus: todo\n"));
        assert_eq!(body, "\n# Title\n\nBody.\n");
    }

    #[test]
    fn content_without_frontmatter_is_all_body() {
        let content = "# Just a note\n\nNo frontmatter here.\n";
        let (block, body) = split_frontmatter(content);
        assert_eq!(block, None);
        assert_eq!(body, content);
    }

    #[test]
    fn unclosed_frontmatter_is_treated_as_body() {
        let content = "---\ntype: Work item\n\n# No closing fence\n";
        let (block, body) = split_frontmatter(content);
        assert_eq!(block, None);
        assert_eq!(body, content);
    }

    #[test]
    fn parses_valid_mapping() {
        let mapping = parse_frontmatter("type: Work item\nestimate: 3\n").unwrap();
        assert_eq!(mapping.get("type").and_then(|v| v.as_str()), Some("Work item"));
        assert_eq!(mapping.get("estimate").and_then(|v| v.as_i64()), Some(3));
    }

    #[test]
    fn malformed_yaml_returns_error() {
        assert!(parse_frontmatter("status: [unclosed\n").is_err());
    }

    #[test]
    fn non_mapping_frontmatter_returns_error() {
        assert!(parse_frontmatter("- just\n- a list\n").is_err());
    }

    #[test]
    fn extracts_wikilink_targets_including_piped_alias() {
        assert_eq!(wikilink_targets("[[atlas]]"), vec!["atlas"]);
        assert_eq!(wikilink_targets("[[maya-chen|Maya]]"), vec!["maya-chen"]);
        assert_eq!(wikilink_targets("see [[a]] and [[b|B]]"), vec!["a", "b"]);
        assert!(wikilink_targets("no links here").is_empty());
    }

    #[test]
    fn outgoing_links_dedupe_preserving_order() {
        let body = "Link [[b]] then [[a]] then [[b]] again.";
        assert_eq!(extract_outgoing_links(body), vec!["b", "a"]);
    }

    #[test]
    fn h1_title_is_first_h1_line_anywhere_in_body() {
        assert_eq!(extract_h1_title("\n# Ship it\n\nBody.\n"), Some("Ship it".to_string()));
        assert_eq!(extract_h1_title("intro\n\n# Later heading\n"), Some("Later heading".to_string()));
        assert_eq!(extract_h1_title("## Only h2\n\nBody.\n"), None);
    }

    #[test]
    fn humanizes_filename_stems() {
        // Sentence case, matching mockParse.ts `humanize` (cross-language
        // parity; see the parity fixtures in entry.rs and mockParse.test.ts).
        assert_eq!(humanize_stem("fix-login-flow"), "Fix login flow");
        assert_eq!(humanize_stem("fld-7"), "Fld 7");
        assert_eq!(humanize_stem("meeting-notes"), "Meeting notes");
    }

    #[test]
    fn snippet_strips_markdown_and_truncates() {
        let body = "# Heading\n\nSome **bold** text with a [[target|nice link]].\n";
        assert_eq!(extract_snippet(body), "Some bold text with a nice link.");
        let long = format!("# H\n\n{}", "x".repeat(400));
        assert_eq!(extract_snippet(&long).chars().count(), 160);
    }

    #[test]
    fn converts_yaml_values_to_json() {
        let yaml: serde_yaml::Value =
            serde_yaml::from_str("kind: select\noptions:\n  - id: urgent\n    color: '#DE3B4E'\n")
                .unwrap();
        let json = yaml_to_json(&yaml);
        assert_eq!(json["kind"], "select");
        assert_eq!(json["options"][0]["id"], "urgent");
        assert_eq!(json["options"][0]["color"], "#DE3B4E");
    }
}
