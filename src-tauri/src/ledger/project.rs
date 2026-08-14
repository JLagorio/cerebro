//! `project()` — the pure, byte-stable projection of reduced Belief state to
//! OKF v0.2 markdown (M22.5; landed with M22.3 because `belief.attested`
//! pins `attested_content_hash` to the projection of the pinned revision,
//! so the reducer cannot validate attestations without it).
//!
//! Byte-stability is a RENDERING CONTRACT, not YAML round-tripping: fields
//! are structured state, and this module defines the one canonical spelling
//! of that state — frontmatter keys in stored order, wikilinks quoted,
//! `{ by, at }`-shaped objects in flow style, `sources` entries in block
//! style, plain scalars unquoted unless YAML would misread them. The
//! demo-vault knowledge corpus is written in exactly this spelling, which
//! is what `project(reduce(migrate(file))) == read(file)` proves.
//!
//! Writes NOTHING in M22. M23 arms it.

/// Render one Belief revision (content + fields) to complete OKF markdown.
/// An empty fields object projects the content alone — index/log documents
/// have no frontmatter and must round-trip untouched. `content` is the
/// exact body bytes after the closing frontmatter delimiter (including any
/// leading blank line), so concatenation is byte-exact by construction.
pub fn project(content: &str, fields: &serde_json::Value) -> String {
    let Some(object) = fields.as_object().filter(|o| !o.is_empty()) else {
        return content.to_string();
    };
    let mut out = String::from("---\n");
    for (key, value) in object {
        render_top_field(&mut out, key, value);
    }
    out.push_str("---\n");
    out.push_str(content);
    out
}

fn render_top_field(out: &mut String, key: &str, value: &serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => render_array_field(out, key, items),
        serde_json::Value::Object(_) => {
            out.push_str(key);
            out.push_str(": ");
            render_flow(out, value);
            out.push('\n');
        }
        scalar => {
            out.push_str(key);
            out.push_str(": ");
            out.push_str(&render_scalar(scalar, false));
            out.push('\n');
        }
    }
}

fn render_array_field(out: &mut String, key: &str, items: &[serde_json::Value]) {
    let all_scalars = items.iter().all(|i| !i.is_array() && !i.is_object());
    let flow_safe = all_scalars
        && items
            .iter()
            .all(|i| !i.as_str().is_some_and(|s| needs_quote(s, true)));
    if items.is_empty() || (all_scalars && flow_safe) {
        // tags: [a, b] — plain scalars stay on one line.
        out.push_str(key);
        out.push_str(": [");
        for (i, item) in items.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            out.push_str(&render_scalar(item, true));
        }
        out.push_str("]\n");
        return;
    }
    out.push_str(key);
    out.push_str(":\n");
    for item in items {
        match item {
            serde_json::Value::Object(map) if map.len() > 2 => {
                // sources entries: block maps, keys in stored order.
                let mut first = true;
                for (k, v) in map {
                    out.push_str(if first { "  - " } else { "    " });
                    first = false;
                    out.push_str(k);
                    out.push_str(": ");
                    match v {
                        serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                            render_flow(out, v)
                        }
                        scalar => out.push_str(&render_scalar(scalar, false)),
                    }
                    out.push('\n');
                }
            }
            serde_json::Value::Object(_) => {
                // verified entries: small { by, at } records stay flow.
                out.push_str("  - ");
                render_flow(out, item);
                out.push('\n');
            }
            scalar => {
                out.push_str("  - ");
                out.push_str(&render_scalar(scalar, false));
                out.push('\n');
            }
        }
    }
}

/// Flow-style rendering for nested values: `{ k: v, k2: v2 }` / `[a, b]`.
fn render_flow(out: &mut String, value: &serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            out.push_str("{ ");
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(k);
                out.push_str(": ");
                render_flow(out, v);
            }
            out.push_str(" }");
        }
        serde_json::Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                render_flow(out, item);
            }
            out.push(']');
        }
        scalar => out.push_str(&render_scalar(scalar, true)),
    }
}

fn render_scalar(value: &serde_json::Value, flow: bool) -> String {
    match value {
        serde_json::Value::String(s) => {
            if needs_quote(s, flow) {
                quote(s)
            } else {
                s.clone()
            }
        }
        serde_json::Value::Null => "null".to_string(),
        other => other.to_string(), // numbers and booleans keep JSON spelling
    }
}

/// Would YAML misread this string as something else, or swallow structure?
/// Quote it then — and only then, so the corpus's plain spellings survive.
fn needs_quote(s: &str, flow: bool) -> bool {
    if s.is_empty() {
        return true;
    }
    let first = s.chars().next().unwrap();
    if "[]{}#&*!|>'\"%@`".contains(first) || first.is_whitespace() {
        return true;
    }
    if s.ends_with(char::is_whitespace) || s.ends_with(':') {
        return true;
    }
    if s.starts_with("- ") || s.starts_with("? ") || s == "-" || s == "~" {
        return true;
    }
    if s.contains(": ") || s.contains(" #") || s.contains('\n') || s.contains('"') {
        return true;
    }
    if flow && s.contains([',', '[', ']', '{', '}']) {
        return true;
    }
    // Strings YAML would read as a different scalar type.
    let lower = s.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "true" | "false" | "null" | "yes" | "no" | "on" | "off"
    ) {
        return true;
    }
    if s.parse::<f64>().is_ok() {
        return true;
    }
    false
}

fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// The projection's inverse for migration (M22.5/6): split an OKF file
/// into exact body bytes and order-preserving JSON fields. Pure; reads and
/// writes nothing.
pub fn parse_okf(text: &str) -> Result<(String, serde_json::Value), String> {
    let (block, body) = crate::vault::parse::split_frontmatter(text);
    let Some(block) = block else {
        return Ok((text.to_string(), serde_json::json!({})));
    };
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(block).map_err(|e| format!("frontmatter: {e}"))?;
    Ok((body.to_string(), yaml_to_json(&yaml)?))
}

fn yaml_to_json(value: &serde_yaml::Value) -> Result<serde_json::Value, String> {
    Ok(match value {
        serde_yaml::Value::Null => serde_json::Value::Null,
        serde_yaml::Value::Bool(b) => serde_json::Value::Bool(*b),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_json::Value::from(i)
            } else if let Some(u) = n.as_u64() {
                serde_json::Value::from(u)
            } else {
                serde_json::Value::from(n.as_f64().ok_or("unrepresentable YAML number")?)
            }
        }
        serde_yaml::Value::String(s) => serde_json::Value::String(s.clone()),
        serde_yaml::Value::Sequence(items) => {
            serde_json::Value::Array(items.iter().map(yaml_to_json).collect::<Result<_, _>>()?)
        }
        serde_yaml::Value::Mapping(map) => {
            let mut out = serde_json::Map::new();
            for (key, item) in map {
                let key = key
                    .as_str()
                    .ok_or("non-string frontmatter key — not OKF")?
                    .to_string();
                out.insert(key, yaml_to_json(item)?);
            }
            serde_json::Value::Object(out)
        }
        serde_yaml::Value::Tagged(_) => return Err("tagged YAML is not OKF".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every demo-vault knowledge file — the golden corpus — must survive
    /// parse → project byte-identically, AND survive the reducer: a
    /// migrated-shape belief.created folded through `reduce` projects the
    /// same bytes. This is `project(reduce(migrate(file))) == read(file)`
    /// with the M22.6 migrator's exact body mapping inlined.
    #[test]
    fn every_demo_vault_knowledge_file_round_trips_byte_identically() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../demo-vault/knowledge");
        let store = "feedfacefeedfacefeedfacefeedface";
        let mut checked = 0;
        for entry in walkdir::WalkDir::new(&root) {
            let entry = entry.unwrap();
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|e| e.to_str()) != Some("md")
            {
                continue;
            }
            let original = std::fs::read_to_string(entry.path()).unwrap();
            let (content, fields) =
                parse_okf(&original).unwrap_or_else(|e| panic!("{}: {e}", entry.path().display()));
            assert_eq!(
                project(&content, &fields),
                original,
                "{}: parse → project must be byte-identical",
                entry.path().display()
            );

            // Through the reducer, as the migrator will emit it.
            let rel = entry
                .path()
                .strip_prefix(&root)
                .unwrap()
                .to_str()
                .unwrap()
                .to_string();
            let body = crate::ledger::schema::BeliefCreated {
                schema: crate::ledger::schema::BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: crate::ledger::schema::Actor {
                    id: crate::ledger::schema::ACTOR_MIGRATOR.to_string(),
                },
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                belief_id: crate::ledger::schema::migrate_id(store, "belief", &rel),
                subject: crate::ledger::schema::SubjectRef::Resolved {
                    entity_id: crate::ledger::schema::migrate_id(store, "entity", &rel),
                    aliases: vec![rel.clone()],
                },
                content: content.clone(),
                fields: fields.clone(),
                basis: crate::ledger::schema::BeliefBasis::Unsupported {
                    reason: "migrated from OKF markdown without captured observations".into(),
                },
            };
            let frame = crate::ledger::frame::tests::fixture(
                1,
                store,
                crate::ledger::schema::KIND_BELIEF_CREATED,
                serde_json::to_value(&body).unwrap(),
            );
            let state = crate::ledger::reduce::reduce(&[frame], store);
            assert!(state.anomalies.is_empty(), "{rel}: {:?}", state.anomalies);
            let belief = state.beliefs.values().next().unwrap();
            let revision = belief.current();
            assert_eq!(
                project(&revision.content, &revision.fields),
                original,
                "{rel}: project(reduce(migrate(file))) must equal read(file)"
            );
            checked += 1;
        }
        assert!(
            checked >= 9,
            "the golden corpus is present ({checked} files)"
        );
    }

    #[test]
    fn a_full_concept_projects_to_its_pinned_bytes() {
        // The rendering contract in one golden sample: stored order, flow
        // maps, block wikilinks, block sources, quoting only where YAML
        // demands it.
        let fields = serde_json::json!({
            "type": "Reference",
            "title": "Warehouse cutover: go-live and rollback",
            "about": ["[[phoenix-warehouse-rollout]]"],
            "tags": ["operations", "phoenix"],
            "lifecycle": "draft",
            "generated": { "by": "claude-code", "at": "2026-07-28T09:05:00Z" },
            "verified": [
                { "by": "process:metrics-nightly", "at": "2026-07-26T02:00:00Z" },
                { "by": "human:josef", "at": "2026-07-26T09:15:00Z" }
            ],
            "usage_window": { "from": "2026-06-01", "to": "2026-06-30" },
            "sources": [
                {
                    "id": "ops-project",
                    "resource": "/records/projects/phoenix-warehouse-rollout.md",
                    "title": "Decision: conflicts are resolved by a person",
                    "usage_count": 1840,
                    "usage_window": { "from": "2026-07-01", "to": "2026-07-25" }
                }
            ]
        });
        let body = "\n# The guarantee\n\nBody text.\n";
        let want = concat!(
            "---\n",
            "type: Reference\n",
            "title: \"Warehouse cutover: go-live and rollback\"\n",
            "about:\n",
            "  - \"[[phoenix-warehouse-rollout]]\"\n",
            "tags: [operations, phoenix]\n",
            "lifecycle: draft\n",
            "generated: { by: claude-code, at: 2026-07-28T09:05:00Z }\n",
            "verified:\n",
            "  - { by: process:metrics-nightly, at: 2026-07-26T02:00:00Z }\n",
            "  - { by: human:josef, at: 2026-07-26T09:15:00Z }\n",
            "usage_window: { from: 2026-06-01, to: 2026-06-30 }\n",
            "sources:\n",
            "  - id: ops-project\n",
            "    resource: /records/projects/phoenix-warehouse-rollout.md\n",
            "    title: \"Decision: conflicts are resolved by a person\"\n",
            "    usage_count: 1840\n",
            "    usage_window: { from: 2026-07-01, to: 2026-07-25 }\n",
            "---\n",
            "\n# The guarantee\n\nBody text.\n",
        );
        assert_eq!(project(body, &fields), want);
    }

    #[test]
    fn empty_fields_project_the_content_untouched() {
        let body = "# Knowledge\n\nNo frontmatter here.\n";
        assert_eq!(project(body, &serde_json::json!({})), body);
    }

    #[test]
    fn quoting_fires_exactly_when_yaml_would_misread() {
        let plain = [
            "KR — Onboarding completion",
            "Phoenix cutover standup, 2026-07-28",
            "claude-code/2.0",
            "process:metrics-nightly",
            "all sync telemetry in the eu-west region",
            "2026-07-26T11:20:00Z",
        ];
        for s in plain {
            assert!(!needs_quote(s, false), "{s:?} must stay plain");
        }
        let quoted = [
            "Decision: offline window is 72 hours",
            "[[wikilink]]",
            "",
            " leading",
            "trailing ",
            "true",
            "1840",
            "ends with colon:",
            "a # comment trap",
        ];
        for s in quoted {
            assert!(needs_quote(s, false), "{s:?} must be quoted");
        }
        // Flow context additionally quotes structural characters.
        assert!(needs_quote("a, b", true));
        assert!(!needs_quote("a, b", false));
    }

    #[test]
    fn projection_is_deterministic() {
        let fields = serde_json::json!({ "type": "Metric", "tags": ["a"] });
        let a = project("body\n", &fields);
        let b = project("body\n", &fields);
        assert_eq!(a, b);
    }
}
