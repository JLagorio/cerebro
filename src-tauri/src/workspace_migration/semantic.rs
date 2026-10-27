//! Checked legacy semantics to an inactive selected-store stage; no activation.
use super::{
    identity::{self, IdentityPlan},
    inventory::{self, Carrier, MigrationInventory, Status, SyntaxNode},
    stage::{self, RecordProposal, StagePlan, StageResult},
};
use crate::{
    vault::{
        link::TargetIndex,
        schema::{FieldKind, VaultSchema},
    },
    workspace_service::{
        types::values::{PropertyValue, RelationResolution, ValueSchema},
        value,
    },
};
use std::collections::{BTreeMap, BTreeSet};

/// Consumes an explicitly approved identity proposal, never permission to activate.
/// Requested-path evidence is re-read; full-root accounting and final freshness
/// remain the existing stage's responsibility. All other carriers stay verbatim.
/// No filesystem output, receipt, registration or Agent admission is performed.
pub fn prepare_semantic_stage(
    inventory: &MigrationInventory,
    approved: IdentityPlan,
) -> StageResult<StagePlan> {
    approved
        .check_inventory(inventory)
        .map_err(|e| stage::error(e.kind, e.detail))?;
    if inventory
        .coverage
        .requested_paths
        .iter()
        .any(|p| stage::exclusion(p).is_some())
    {
        return Err(stage::error(
            "excluded_source",
            "Private excluded sources cannot supply semantic evidence.",
        ));
    }
    let root = stage::canonical_root(&inventory.root)?;
    if root != inventory.root {
        return Err(stage::error(
            "identity_binding_changed",
            "The reviewed source root changed.",
        ));
    }
    super::format_gate::guard_legacy_access(&root)?;
    let fresh = inventory::inventory_workspace(
        &root,
        &inventory::InventoryScope {
            paths: inventory.coverage.requested_paths.clone(),
        },
    )
    .map_err(|e| stage::error(e.kind, e.detail))?;
    if &fresh != inventory {
        return Err(stage::error(
            "stale_inventory",
            "Source bytes or semantic evidence changed after review.",
        ));
    }
    if inventory.rows.iter().any(|row| {
        matches!(row.status, Status::Blocked | Status::Ambiguous)
            && !(row.carrier == Carrier::Other
                && row.issues.iter().all(|i| i.kind == "unsupported_carrier"))
    }) {
        return Err(stage::error(
            "inventory_not_ready",
            "Malformed, unavailable or unresolved semantic evidence cannot be converted.",
        ));
    }
    let manifest = approved
        .into_proposed_manifest(identity::mint_uuid_v4)
        .map_err(|e| stage::error(e.kind, e.detail))?;
    let identities: BTreeMap<_, _> = manifest
        .records
        .iter()
        .map(|r| (r.path.as_str(), r))
        .collect();
    let convertible = |row: &&inventory::Row| {
        row.carrier == Carrier::Markdown
            && row.status == Status::Ready
            && !stage::retained_carrier(&row.path)
    };
    let convertible_paths: BTreeSet<_> = inventory
        .rows
        .iter()
        .filter(convertible)
        .map(|r| r.path.as_str())
        .collect();
    let ids: BTreeMap<_, _> = identities
        .iter()
        .filter(|(path, _)| convertible_paths.contains(**path))
        .map(|(path, r)| ((*path).to_owned(), r.record_id.clone()))
        .collect();
    // Entry supplies only legacy classification/schema/target evidence. Metadata
    // values are always decoded from original syntax, never copied from its
    // JSON projection (which cannot retain exact decimal lexemes).
    let entries: Vec<_> = inventory
        .rows
        .iter()
        .filter(|r| matches!(r.carrier, Carrier::Markdown | Carrier::GovernedConcept))
        .filter_map(|r| {
            let original = r.original.as_ref()?;
            let source = std::str::from_utf8(&original.bytes).ok()?;
            Some(crate::vault::entry::build_entry(
                &r.path,
                source,
                String::new(),
                String::new(),
            ))
        })
        .collect();
    let mut reversed = entries.clone();
    reversed.reverse();
    let index = TargetIndex::build(&entries);
    let reverse_index = TargetIndex::build(&reversed);
    let mut type_names = BTreeSet::new();
    if entries
        .iter()
        .filter(|e| e.entry_type.as_deref() == Some("Type"))
        .any(|e| !type_names.insert(e.title.clone()))
    {
        return Err(stage::error(
            "ambiguous_schema",
            "More than one Type declaration has the same schema name.",
        ));
    }
    let table = crate::vault::schema::table().map_err(|e| stage::error("schema_unavailable", e))?;
    let schema = VaultSchema::from_entries(&entries, table);
    let by_path: BTreeMap<_, _> = entries.iter().map(|e| (e.path.as_str(), e)).collect();
    let mut proposals = Vec::new();
    for row in inventory.rows.iter().filter(convertible) {
        let original = row
            .original
            .as_ref()
            .ok_or_else(|| stage::error("inventory_not_ready", "An original source is missing."))?;
        let identity = identities.get(row.path.as_str()).ok_or_else(|| {
            stage::error(
                "identity_binding_changed",
                "A converted record lacks a reviewed identity.",
            )
        })?;
        if identity.source_hash != original.sha256 {
            return Err(stage::error(
                "identity_binding_changed",
                "Reviewed identity source hash differs.",
            ));
        }
        let mut values = match row.syntax.as_ref().map(syntax_value).transpose()? {
            None => BTreeMap::new(),
            Some(PropertyValue::Object { value }) => value,
            _ => {
                return Err(stage::error(
                    "unsupported_mapping",
                    "Ordinary metadata must be a mapping.",
                ))
            }
        };
        let entry = by_path.get(row.path.as_str()).ok_or_else(|| {
            stage::error(
                "inventory_not_ready",
                "Legacy semantic evidence is unavailable.",
            )
        })?;
        if entry.parse_error.is_some() {
            return Err(stage::error(
                "inventory_not_ready",
                "Legacy semantic evidence failed.",
            ));
        }
        if values
            .get("type")
            .is_some_and(|v| !matches!(v, PropertyValue::String { .. } | PropertyValue::Null {}))
        {
            return Err(stage::error(
                "unsupported_type",
                "Declared record type must be text or null.",
            ));
        }
        for (key, v) in &mut values {
            if schema
                .field_for(entry, key)
                .is_some_and(|f| f.kind == FieldKind::Date)
            {
                match v {
                    PropertyValue::String { value: text } => {
                        let source = serde_json::to_string(text).map_err(|_| {
                            stage::error("invalid_metadata", "Date text cannot be encoded.")
                        })?;
                        *v = value::decode_json(&source, ValueSchema::Date)
                            .or_else(|_| value::decode_json(&source, ValueSchema::Instant))
                            .map_err(|e| stage::error("unsupported_date", e.message))?;
                    }
                    PropertyValue::Null {} => {}
                    _ => {
                        return Err(stage::error(
                            "unsupported_date",
                            "Declared dates require supported date text.",
                        ))
                    }
                }
            }
            if entry.relationships.contains_key(key) {
                *v = relation(v, &index, &reverse_index, &ids)?;
            }
        }
        let encoded = serde_json::to_string(&PropertyValue::Object { value: values })
            .map_err(|_| stage::error("invalid_metadata", "Metadata cannot be encoded."))?;
        value::decode_tagged(&encoded).map_err(|e| stage::error("invalid_metadata", e.message))?;
        proposals.push(RecordProposal {
            id: identity.record_id.clone(),
            path: row.path.clone(),
            body_start: row.body_start.ok_or_else(|| {
                stage::error("invalid_body_boundary", "Body boundary was not recorded.")
            })?,
            metadata_json: encoded,
            required_parts: Vec::new(),
        });
    }
    // The stage retains every discovered attachment/comment/ledger/compatibility
    // part; this bounded producer makes no new claim about reference extraction.
    let plan = stage::prepare_stage(&root, &manifest.workspace_id, proposals)?;
    let reviewed = inventory
        .rows
        .iter()
        .filter_map(|row| {
            row.original
                .as_ref()
                .map(|o| (row.path.as_str(), o.sha256.as_str()))
        })
        .collect();
    plan.check_reviewed_sources(&reviewed)?;
    Ok(plan)
}

fn syntax_value(node: &SyntaxNode) -> StageResult<PropertyValue> {
    Ok(match node {
        SyntaxNode::Scalar(scalar) if !scalar.plain => PropertyValue::String {
            value: scalar.text.clone(),
        },
        SyntaxNode::Scalar(scalar) => {
            // Decode exact JSON number lexemes before any YAML number reader.
            // YAML is only a classifier for otherwise unsupported spellings.
            if let Ok(value) = value::decode_json(&scalar.text, ValueSchema::Plain) {
                return Ok(value);
            }
            match serde_yaml::from_str::<serde_yaml::Value>(&scalar.text) {
                Ok(serde_yaml::Value::String(_)) => PropertyValue::String {
                    value: scalar.text.clone(),
                },
                Ok(serde_yaml::Value::Null) => PropertyValue::Null {},
                Ok(serde_yaml::Value::Bool(v)) => PropertyValue::Boolean { value: v },
                Ok(serde_yaml::Value::Number(_)) => {
                    return Err(stage::error(
                        "unsupported_scalar",
                        "Noncanonical YAML number spelling cannot convert exactly.",
                    ))
                }
                _ => {
                    return Err(stage::error(
                        "unsupported_scalar",
                        "Unsupported scalar semantics.",
                    ))
                }
            }
        }
        SyntaxNode::Sequence(nodes) => PropertyValue::Array {
            value: nodes.iter().map(syntax_value).collect::<StageResult<_>>()?,
        },
        SyntaxNode::Mapping(pairs) => {
            let mut values = BTreeMap::new();
            for (key, node) in pairs {
                let SyntaxNode::Scalar(key) = key else {
                    return Err(stage::error(
                        "unsupported_key",
                        "Only string metadata keys convert.",
                    ));
                };
                if values
                    .insert(key.text.clone(), syntax_value(node)?)
                    .is_some()
                {
                    return Err(stage::error("duplicate_key", "Duplicate metadata key."));
                }
            }
            PropertyValue::Object { value: values }
        }
        SyntaxNode::Alias => {
            return Err(stage::error(
                "unsupported_alias",
                "Aliases require a separate codec.",
            ))
        }
    })
}

fn relation(
    value: &PropertyValue,
    index: &TargetIndex<'_>,
    reverse: &TargetIndex<'_>,
    ids: &BTreeMap<String, String>,
) -> StageResult<PropertyValue> {
    Ok(match value {
        PropertyValue::String { value: spelling } => {
            let text = spelling.trim();
            let targets = crate::vault::parse::wikilink_targets(text);
            if !text.starts_with("[[")
                || !text.ends_with("]]")
                || text[2..text.len() - 2].contains(['[', ']'])
                || targets.len() != 1
            {
                return Err(stage::error(
                    "unsupported_relation_shape",
                    "A relation must be one complete wikilink, retaining its spelling.",
                ));
            }
            let (entry, fragment) = index.resolve_with_fragment(&targets[0]).ok_or_else(|| {
                stage::error(
                    "unresolved_relation",
                    "Relation target is unresolved in the reviewed scope.",
                )
            })?;
            if reverse
                .resolve(&targets[0])
                .is_none_or(|other| other.path != entry.path)
            {
                return Err(stage::error(
                    "ambiguous_relation",
                    "Relation target depends on equal-precedence corpus order.",
                ));
            }
            let target_id = ids.get(&entry.path).ok_or_else(|| {
                stage::error(
                    "retained_relation_target",
                    "Relations to retained carriers require their identity adapter.",
                )
            })?;
            PropertyValue::Relation {
                spelling: spelling.clone(),
                fragment: fragment.map(str::to_owned),
                resolution: RelationResolution::Resolved {
                    target_id: target_id.clone(),
                },
            }
        }
        PropertyValue::Array { value } => PropertyValue::Array {
            value: value
                .iter()
                .map(|v| relation(v, index, reverse, ids))
                .collect::<StageResult<_>>()?,
        },
        _ => {
            return Err(stage::error(
                "unsupported_relation_shape",
                "Relation arrays must contain complete wikilinks only.",
            ))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        vault::testutil,
        workspace_migration::{
            identity,
            inventory::{self, InventoryScope},
            stage,
        },
    };
    use serde_json::{json, Value};
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn fixture(label: &str, files: &[(&str, &str)]) -> (PathBuf, MigrationInventory) {
        let root = testutil::temp_vault(label);
        for (path, source) in files {
            testutil::write(&root, path, source);
        }
        let inventory = inventory::inventory_workspace(
            &root,
            &InventoryScope {
                paths: files.iter().map(|(p, _)| p.to_string()).collect(),
            },
        )
        .unwrap();
        (root, inventory)
    }
    fn approved(inventory: &MigrationInventory) -> IdentityPlan {
        identity::plan_identities(inventory, None, &[], &[]).unwrap()
    }
    fn outputs(root: &Path) -> (PathBuf, PathBuf) {
        (
            root.with_extension("bodies"),
            root.with_extension("metadata"),
        )
    }
    fn metadata(root: &Path, path: &str) -> Value {
        let db = rusqlite::Connection::open(root.join("workspace.db")).unwrap();
        let text: String = db
            .query_row("SELECT metadata FROM records WHERE path=?1", [path], |r| {
                r.get(0)
            })
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    // Break caught: converting through Entry/JSON rounds numbers or drops null,
    // strips a body BOM, reconstructs CRLF, or infers absent Agent grants.
    #[test]
    fn produces_exact_values_and_bodies_without_inferred_grants() {
        let original = "\u{feff}---\r\ntype: Agent\r\nname: '007'\r\nplain: 007\r\namount: 1.2300\r\npresent: null\r\npaused: true\r\nsource_system: notion\r\nsource_record_id: original-id\r\nimport_hash: exact-stamp\r\ncustom: {text: 'ordinary [[link]] prose', items: [false, null, ''] }\r\n---  \r\n# Worker\r\nBody\r\n";
        let (source, inventory) = fixture(
            "m99-semantic-exact",
            &[
                ("moved/worker.md", original),
                ("plain.md", "\u{feff}# Plain\r\nBody\r\n"),
            ],
        );
        let plan = prepare_semantic_stage(&inventory, approved(&inventory)).unwrap();
        let (bodies, store) = outputs(&source);
        let staged = stage::stage_conversion(plan, &bodies, &store).unwrap();
        let checked = stage::validate_cutover(&staged).unwrap();
        assert!(checked.whole_root_accounted);
        assert!(!checked.activation_blockers.is_empty());
        assert_eq!(
            fs::read(bodies.join("moved/worker.md")).unwrap(),
            b"# Worker\r\nBody\r\n"
        );
        assert_eq!(
            fs::read(bodies.join("plain.md")).unwrap(),
            "\u{feff}# Plain\r\nBody\r\n".as_bytes()
        );
        assert_eq!(
            fs::read(store.join("originals/moved/worker.md")).unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            fs::read(source.join("moved/worker.md")).unwrap(),
            original.as_bytes()
        );
        let values = metadata(&store, "moved/worker.md");
        assert_eq!(
            values["value"]["amount"],
            json!({"kind":"decimal","value":"1.2300"})
        );
        assert_eq!(values["value"]["present"], json!({"kind":"null"}));
        for key in ["name", "plain"] {
            assert_eq!(values["value"][key], json!({"kind":"string","value":"007"}));
        }
        assert_eq!(
            values["value"]["type"],
            json!({"kind":"string","value":"Agent"})
        );
        assert_eq!(
            values["value"]["paused"],
            json!({"kind":"boolean","value":true})
        );
        assert_eq!(
            values["value"]["source_system"],
            json!({"kind":"string","value":"notion"})
        );
        assert_eq!(
            values["value"]["source_record_id"],
            json!({"kind":"string","value":"original-id"})
        );
        assert_eq!(
            values["value"]["import_hash"],
            json!({"kind":"string","value":"exact-stamp"})
        );
        assert_eq!(
            values["value"]["custom"]["value"]["text"],
            json!({"kind":"string","value":"ordinary [[link]] prose"})
        );
        assert!(values["value"].get("tools").is_none());
        assert!(values["value"].get("missing").is_none());
        let workspace: String = rusqlite::Connection::open(store.join("workspace.db"))
            .unwrap()
            .query_row("SELECT workspace_id FROM workspace", [], |r| r.get(0))
            .unwrap();
        stage::open_staged(&source, &bodies, &store, &workspace).unwrap();
    }

    // Break caught: stringifying a declared date or relation discards schema,
    // stable target identity, original spelling, fragment or sequence order.
    #[test]
    fn retains_explicit_schema_and_resolves_ordered_relations() {
        let (source, inventory) = fixture("m99-semantic-relations", &[
            ("types/task.md", "---\ntype: Type\nfields:\n  due: {kind: date}\n---\n# Task\n"),
            ("a.md", "---\ntype: Task\ndue: '2026-10-23'\nlinks: ['[[b#Part|B]]', '[[c]]', '[[b]]']\n---\n# A\n"),
            ("b.md", "# B\n"), ("c.md", "# C\n")]);
        let plan = prepare_semantic_stage(&inventory, approved(&inventory)).unwrap();
        let (bodies, store) = outputs(&source);
        stage::stage_conversion(plan, &bodies, &store).unwrap();
        let data = metadata(&store, "a.md");
        assert_eq!(
            data["value"]["due"],
            json!({"kind":"date","value":"2026-10-23"})
        );
        let links = data["value"]["links"]["value"].as_array().unwrap();
        let db = rusqlite::Connection::open(store.join("workspace.db")).unwrap();
        let bid: String = db
            .query_row("SELECT id FROM records WHERE path='b.md'", [], |r| r.get(0))
            .unwrap();
        let cid: String = db
            .query_row("SELECT id FROM records WHERE path='c.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            links[0],
            json!({"kind":"relation","spelling":"[[b#Part|B]]","fragment":"Part","resolution":{"status":"resolved","targetId":bid}})
        );
        assert_eq!(links[1]["resolution"]["targetId"], cid);
        assert_eq!(links[2]["resolution"]["targetId"], bid);
        assert_eq!(
            metadata(&store, "types/task.md")["value"]["fields"]["value"]["due"]["value"]["kind"],
            json!({"kind":"string","value":"date"})
        );
    }

    // Break caught: governed/compatibility aliases enter ordinary conversion.
    #[test]
    fn retains_governed_ledger_cli_views_and_embedded_sheets_exactly() {
        let files = [
            ("plain.md", "# Plain\n"),
            (
                "Knowledge/concept.md",
                "---\ntitle: Original\n---\n# Claim\n",
            ),
            (".cerebro/ledger/segment.jsonl", "{\"original\":true}\n"),
            (
                ".claude/agents/helper.md",
                "---\ntools: anything\n---\nExternal\n",
            ),
            ("views/board.yml", "layout: board\n"),
            (
                "sheet.md",
                "---\nlabel: Sheet\n---\n```cerebro-sheet\nsource: original\n```\n",
            ),
        ];
        let (source, inventory) = fixture("m99-semantic-retained", &files);
        let plan = prepare_semantic_stage(&inventory, approved(&inventory)).unwrap();
        let (bodies, store) = outputs(&source);
        stage::stage_conversion(plan, &bodies, &store).unwrap();
        for (path, original) in &files[1..] {
            assert_eq!(fs::read(bodies.join(path)).unwrap(), original.as_bytes());
            assert_eq!(
                fs::read(store.join("originals").join(path)).unwrap(),
                original.as_bytes()
            );
        }
        let db = rusqlite::Connection::open(store.join("workspace.db")).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM records", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    // Break caught: first-wins ambiguity, prose or mixed relation arrays are
    // silently converted to a different canonical meaning.
    #[test]
    fn unsupported_relation_and_scalar_semantics_refuse_before_output() {
        for (label, files, kind) in [
            (
                "ambiguous",
                vec![
                    ("a.md", "---\nlink: '[[same]]'\n---\nA"),
                    ("x/same.md", "# First"),
                    ("y/same.md", "# Second"),
                ],
                "ambiguous_relation",
            ),
            (
                "prose",
                vec![("a.md", "---\nlink: 'See [[b]]'\n---\nA"), ("b.md", "# B")],
                "unsupported_relation_shape",
            ),
            (
                "mixed",
                vec![
                    ("a.md", "---\nlink: ['[[b]]', plain]\n---\nA"),
                    ("b.md", "# B"),
                ],
                "unsupported_relation_shape",
            ),
            (
                "number",
                vec![("a.md", "---\nnumber: 0x10\n---\nA")],
                "unsupported_scalar",
            ),
            (
                "date",
                vec![
                    (
                        "types/task.md",
                        "---\ntype: Type\nfields: {due: {kind: date}}\n---\n# Task",
                    ),
                    ("a.md", "---\ntype: Task\ndue: invalid\n---\nA"),
                ],
                "unsupported_date",
            ),
        ] {
            let (source, inventory) = fixture(&format!("m99-semantic-{label}"), &files);
            assert_eq!(
                prepare_semantic_stage(&inventory, approved(&inventory))
                    .unwrap_err()
                    .kind,
                kind
            );
            let (bodies, store) = outputs(&source);
            assert!(!bodies.exists() && !store.exists());
        }
    }

    // Break caught: accepting mutable/forged inventory or a plan from a second
    // root lets changed metadata inherit an old reviewed identity proposal.
    #[test]
    fn stale_forged_or_differently_bound_evidence_refuses() {
        let (source, mut inventory) = fixture(
            "m99-semantic-stale",
            &[("a.md", "---\ntype: Agent\n---\nA")],
        );
        let plan = approved(&inventory);
        fs::write(source.join("a.md"), "---\ntype: Agent\ntools: all\n---\nA").unwrap();
        assert_eq!(
            prepare_semantic_stage(&inventory, plan).unwrap_err().kind,
            "stale_inventory"
        );
        fs::write(source.join("a.md"), "---\ntype: Agent\n---\nA").unwrap();
        let plan = approved(&inventory);
        inventory.rows[0].syntax = None;
        assert_eq!(
            prepare_semantic_stage(&inventory, plan).unwrap_err().kind,
            "stale_inventory"
        );
        let (_, first) = fixture("m99-semantic-binding-a", &[("a.md", "# A")]);
        let (_, second) = fixture("m99-semantic-binding-b", &[("a.md", "# A")]);
        assert_eq!(
            prepare_semantic_stage(&second, approved(&first))
                .unwrap_err()
                .kind,
            "identity_binding_changed"
        );
    }

    // Break caught: ignoring blocked syntax/unresolved targets, or reading an
    // oversize source after the reviewed inventory instead of refusing it.
    #[test]
    fn malformed_unresolved_or_over_budget_inputs_refuse() {
        for source in [
            "---\na: 1\na: 2\n---\nA",
            "---\na: [\n---\nA",
            "---\nlink: '[[missing]]'\n---\nA",
        ] {
            let (_, bad) = fixture("m99-semantic-bad-evidence", &[("a.md", source)]);
            assert_eq!(
                identity::plan_identities(&bad, None, &[], &[])
                    .unwrap_err()
                    .kind,
                "inventory_not_ready"
            );
        }
        let (root, inventory) = fixture("m99-semantic-budget", &[("a.md", "# A")]);
        let plan = approved(&inventory);
        fs::File::create(root.join("a.md"))
            .unwrap()
            .set_len(super::super::syntax::limits().max_file_bytes as u64 + 1)
            .unwrap();
        assert_eq!(
            prepare_semantic_stage(&inventory, plan).unwrap_err().kind,
            "stale_inventory"
        );
        let mut oversized = inventory.clone();
        oversized.coverage.requested_paths =
            vec!["a.md".into(); super::super::syntax::limits().max_files + 1];
        assert_eq!(
            prepare_semantic_stage(&oversized, approved(&inventory))
                .unwrap_err()
                .kind,
            "source_limit"
        );
    }
    // Break caught: staging can discover a newer source after semantic decoding
    // and bind old proposed metadata to those newer source bytes.
    #[test]
    fn stage_snapshot_must_match_the_reviewed_semantic_source_hashes() {
        let (source, inventory) = fixture("m99-semantic-stage-race", &[("a.md", "# Before\n")]);
        let expected = std::collections::BTreeMap::from([(
            "a.md",
            inventory.rows[0].original.as_ref().unwrap().sha256.as_str(),
        )]);
        fs::write(source.join("a.md"), "# After\n").unwrap();
        let plan = stage::prepare_stage(
            &source,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            vec![stage::RecordProposal {
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                path: "a.md".into(),
                body_start: 0,
                metadata_json: "{\"kind\":\"object\",\"value\":{}}".into(),
                required_parts: Vec::new(),
            }],
        )
        .unwrap();
        assert_eq!(
            plan.check_reviewed_sources(&expected).unwrap_err().kind,
            "stale_inventory"
        );
        assert_eq!(fs::read(source.join("a.md")).unwrap(), b"# After\n");
        let (bodies, store) = outputs(&source);
        assert!(!bodies.exists() && !store.exists());
    }
}
