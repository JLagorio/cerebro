//! Original bytes are authoritative; syntax is evidence, never a rewrite codec.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ready,
    Retained,
    Ambiguous,
    Blocked,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Carrier {
    Markdown,
    ViewYaml,
    GovernedConcept,
    GovernedLedger,
    CliDefinition,
    IdentityManifest,
    Other,
}
pub use super::syntax::{Issue, MigrationError, SyntaxNode};
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Original {
    pub sha256: String,
    pub bytes: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    pub path: String,
    pub carrier: Carrier,
    pub status: Status,
    pub original: Option<Original>,
    pub body_start: Option<usize>,
    pub syntax: Option<SyntaxNode>,
    pub issues: Vec<Issue>,
    pub declared_type: Option<String>,
    pub import_stamps: BTreeMap<String, SyntaxNode>,
    pub proposed_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LedgerEvidence {
    pub store_id: Option<String>,
    pub store_identity_in_scope: bool,
    pub projection_codec: String,
    pub projection_codec_sha256: String,
    pub projection_manifest_in_scope: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Coverage {
    pub kind: String,
    pub requested_paths: Vec<String>,
    pub whole_vault: bool,
    pub conversion_attempted: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MigrationInventory {
    pub root: PathBuf,
    pub coverage: Coverage,
    pub rows: Vec<Row>,
    pub ledger: LedgerEvidence,
}
#[derive(Debug, Clone)]
pub struct InventoryScope {
    pub paths: Vec<String>,
}

use super::syntax::{failure, issue, limits};
use std::{collections::BTreeSet, io::Read};

pub(crate) fn valid_path(path: &str) -> bool {
    crate::files::bytes::rel_refusal("migration", path).is_none()
}
fn carrier(path: &str) -> Carrier {
    if path.starts_with("knowledge/") && path.ends_with(".md") {
        Carrier::GovernedConcept
    } else if path.starts_with(".cerebro/ledger/") || path == crate::ledger::manifest::MANIFEST_PATH
    {
        Carrier::GovernedLedger
    } else if (path.starts_with(".claude/agents/") || path.starts_with(".claude/skills/"))
        && path.ends_with(".md")
    {
        Carrier::CliDefinition
    } else if path == ".cerebro/workspace-manifest.json" {
        Carrier::IdentityManifest
    } else if path.ends_with(".md") {
        Carrier::Markdown
    } else if path.ends_with(".yml") || path.ends_with(".yaml") {
        Carrier::ViewYaml
    } else {
        Carrier::Other
    }
}
fn read_original(root: &Path, path: &str, remaining: usize) -> Result<Original, MigrationError> {
    // Reuse the existing anchored descriptor walk. Its final path must equal
    // the requested lexical path, so even an internal symlink is refused.
    let opened = crate::files::bytes::open_in(root, "migration", path).map_err(|_| {
        failure(
            "read_unavailable",
            "Requested source could not be opened within the root.",
        )
    })?;
    if opened.path != root.join(path) {
        return Err(failure(
            "symlink",
            "Inventory does not follow source symlinks.",
        ));
    }
    let before = opened
        .file
        .metadata()
        .map_err(|_| failure("read_unavailable", "Source metadata is unavailable."))?;
    let cap = limits().max_file_bytes.min(remaining);
    if before.len() > cap as u64 {
        return Err(failure(
            "source_limit",
            "Source or aggregate byte limit exceeded.",
        ));
    }
    let mut bytes = Vec::new();
    let mut file = opened.file;
    file.by_ref()
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            failure(
                "read_unavailable",
                "Requested source bytes are unavailable.",
            )
        })?;
    let after = file.metadata().map_err(|_| {
        failure(
            "read_unavailable",
            "Source metadata changed during inventory.",
        )
    })?;
    if bytes.len() > cap {
        return Err(failure(
            "source_limit",
            "Source grew beyond the byte limit.",
        ));
    }
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || after.len() != bytes.len() as u64
    {
        return Err(failure(
            "source_changed",
            "Source changed while being inventoried; retry explicitly.",
        ));
    }
    Ok(Original {
        sha256: crate::ledger::sha256_hex(&bytes),
        bytes,
    })
}
fn scalar(node: &SyntaxNode) -> Option<&str> {
    if let SyntaxNode::Scalar(value) = node {
        Some(&value.text)
    } else {
        None
    }
}
fn fields(node: &SyntaxNode) -> Option<&[(SyntaxNode, SyntaxNode)]> {
    if let SyntaxNode::Mapping(rows) = node {
        Some(rows)
    } else {
        None
    }
}
fn has_sheet_candidate(body: &str) -> bool {
    // Conservative carrier inventory only, not a replacement CommonMark/sheet
    // parser. Any candidate is retained and never converted by this module.
    body.lines().any(|line| {
        let line = line.trim_start_matches(' ');
        let Some(rest) = line
            .strip_prefix("```")
            .or_else(|| line.strip_prefix("~~~"))
        else {
            return false;
        };
        rest.trim_start_matches(['`', '~'])
            .split_whitespace()
            .next()
            == Some(crate::sheet::fence::SHEET_FENCE)
    })
}
fn inspect_row(path: String, original: Original) -> Row {
    let carrier = carrier(&path);
    let retained = matches!(
        carrier,
        Carrier::GovernedConcept
            | Carrier::GovernedLedger
            | Carrier::CliDefinition
            | Carrier::IdentityManifest
    );
    let mut row = Row {
        path,
        carrier,
        status: if retained {
            Status::Retained
        } else {
            Status::Ready
        },
        original: Some(original),
        body_start: None,
        syntax: None,
        issues: Vec::new(),
        declared_type: None,
        import_stamps: BTreeMap::new(),
        proposed_id: None,
    };
    if matches!(
        row.carrier,
        Carrier::GovernedLedger | Carrier::CliDefinition | Carrier::IdentityManifest
    ) {
        return row;
    }
    if row.carrier == Carrier::Other {
        row.status = Status::Blocked;
        row.issues.push(issue(
            "unsupported_carrier",
            "This source needs a separately selected codec.",
        ));
        return row;
    }
    let source = match std::str::from_utf8(&row.original.as_ref().unwrap().bytes) {
        Ok(source) => source,
        Err(_) => {
            row.status = Status::Blocked;
            row.issues.push(issue(
                "invalid_utf8",
                "Original bytes are retained but cannot be interpreted as UTF-8 metadata.",
            ));
            return row;
        }
    };
    let block = if row.carrier == Carrier::ViewYaml {
        Some(source)
    } else {
        let (block, body) = crate::vault::parse::split_frontmatter(source);
        row.body_start = Some(super::stage::body_start(source));
        let without_bom = source.strip_prefix('\u{feff}').unwrap_or(source);
        if block.is_none()
            && (without_bom.starts_with("---\n") || without_bom.starts_with("---\r\n"))
        {
            row.status = Status::Blocked;
            row.issues.push(issue(
                "unclosed_frontmatter",
                "Opening frontmatter fence has no closing fence.",
            ));
        }
        if has_sheet_candidate(body) {
            row.issues.push(issue(
                "sheet_yaml_retained",
                "Sheet fence candidates retain their original YAML/source bytes.",
            ));
            if row.status == Status::Ready {
                row.status = Status::Retained;
            }
        }
        block
    };
    if let Some(block) = block {
        match syntax_inventory(block) {
            Ok((node, issues)) => {
                if !issues.is_empty() {
                    row.status = Status::Blocked;
                }
                row.issues.extend(issues);
                if let Some(fields) = fields(&node) {
                    let stamp_keys = crate::import::table().value["agent_guard"]
                        .as_array()
                        .expect("import stamp keys");
                    for (key, value) in fields {
                        if let Some(key) = scalar(key) {
                            if key == "type" {
                                row.declared_type = scalar(value).map(str::to_owned);
                            }
                            if stamp_keys
                                .iter()
                                .any(|candidate| candidate.as_str() == Some(key))
                            {
                                row.import_stamps.insert(key.into(), value.clone());
                            }
                        }
                    }
                }
                row.syntax = Some(node);
            }
            Err(error) => {
                row.status = Status::Blocked;
                row.issues.push(issue(error.kind, error.detail));
            }
        }
    }
    row
}

pub fn inventory_workspace(
    root: &Path,
    scope: &InventoryScope,
) -> Result<MigrationInventory, MigrationError> {
    let cap = limits();
    if scope.paths.len() > cap.max_files {
        return Err(failure(
            "source_limit",
            "Requested file count exceeds inventory limit.",
        ));
    }
    let mut paths = BTreeSet::new();
    for path in &scope.paths {
        if !valid_path(path) || !paths.insert(path.clone()) {
            return Err(failure(
                "invalid_scope",
                "Inventory paths must be unique contained relative file paths.",
            ));
        }
    }
    let root = std::fs::canonicalize(root)
        .map_err(|_| failure("root_unavailable", "Inventory root is unavailable."))?;
    if !root.is_dir() {
        return Err(failure(
            "root_unavailable",
            "Inventory root is not a directory.",
        ));
    }
    let coverage = Coverage {
        kind: "requested_paths".into(),
        requested_paths: paths.iter().cloned().collect(),
        whole_vault: false,
        conversion_attempted: false,
    };
    let (mut rows, mut total) = (Vec::new(), 0_usize);
    for path in paths {
        match read_original(&root, &path, cap.max_total_bytes.saturating_sub(total)) {
            Ok(original) => {
                total += original.bytes.len();
                rows.push(inspect_row(path, original));
            }
            Err(error) => rows.push(Row {
                carrier: carrier(&path),
                path,
                status: Status::Blocked,
                original: None,
                body_start: None,
                syntax: None,
                issues: vec![issue(error.kind, error.detail)],
                declared_type: None,
                import_stamps: BTreeMap::new(),
                proposed_id: None,
            }),
        }
    }
    // Reuse the existing resolver only after syntax inspection. Its parsed
    // metadata is never conversion evidence; original syntax/bytes above are.
    let entries: Vec<_> = rows
        .iter_mut()
        .filter(|row| {
            row.status != Status::Blocked
                && matches!(row.carrier, Carrier::Markdown | Carrier::GovernedConcept)
        })
        .filter_map(|row| {
            let source = std::str::from_utf8(&row.original.as_ref()?.bytes).ok()?;
            let entry = crate::vault::entry::build_entry(
                &row.path,
                source,
                String::new(),
                String::new(),
            );
            if entry.parse_error.is_some() {
                row.status = Status::Blocked;
                row.issues.push(issue(
                    "semantic_read_unavailable",
                    "The existing metadata reader could not read relation/index evidence; original bytes and syntax are retained.",
                ));
                None
            } else {
                Some(entry)
            }
        })
        .collect();
    let index = crate::vault::link::TargetIndex::build(&entries);
    for row in &mut rows {
        if row.status == Status::Blocked || row.carrier != Carrier::Markdown {
            continue;
        }
        if let Some(entry) = entries.iter().find(|entry| entry.path == row.path) {
            for targets in entry.relationships.values() {
                for target in targets {
                    if index.resolve(target).is_none() {
                        row.status = Status::Ambiguous;
                        row.issues.push(issue(
                            "unresolved_relation",
                            format!("Target is unresolved within requested scope: {target}"),
                        ));
                    }
                }
            }
        }
    }
    let store_path = ".cerebro/ledger/store.json";
    let mut ledger = LedgerEvidence {
        store_id: None,
        store_identity_in_scope: coverage.requested_paths.iter().any(|p| p == store_path),
        projection_codec: "ledger/project.rs:okf-v0.2".into(),
        projection_codec_sha256: crate::ledger::sha256_hex(include_bytes!("../ledger/project.rs")),
        projection_manifest_in_scope: coverage
            .requested_paths
            .iter()
            .any(|p| p == crate::ledger::manifest::MANIFEST_PATH),
    };
    if let Some(row) = rows.iter_mut().find(|r| r.path == store_path) {
        if let Some(original) = &row.original {
            match serde_json::from_slice::<crate::ledger::store::StoreInfo>(&original.bytes) {
                Ok(store)
                    if store.format == crate::ledger::store::STORE_FORMAT
                        && !store.store_id.is_empty() =>
                {
                    ledger.store_id = Some(store.store_id)
                }
                _ => {
                    row.status = Status::Blocked;
                    row.issues.push(issue(
                        "ledger_identity_unavailable",
                        "Existing ledger identity cannot be read; it is never reminted.",
                    ));
                }
            }
        }
    }
    Ok(MigrationInventory {
        root,
        coverage,
        rows,
        ledger,
    })
}
fn syntax_inventory(source: &str) -> Result<(SyntaxNode, Vec<Issue>), MigrationError> {
    super::syntax::inspect(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    fn cases() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../shared/workspace/migration-cases.v1.json"
        ))
        .unwrap()
    }
    fn scope(paths: &[&str]) -> InventoryScope {
        InventoryScope {
            paths: paths.iter().map(|p| p.to_string()).collect(),
        }
    }

    #[test]
    fn shared_syntax_cases_keep_every_original_byte_and_hash() {
        let root = testutil::temp_vault("migration-inventory-cases");
        for case in cases()["cases"].as_array().unwrap() {
            let path = case["path"].as_str().unwrap();
            let source = case["source"].as_str().unwrap();
            testutil::write(&root, path, source);
            let inventory = inventory_workspace(&root, &scope(&[path])).unwrap();
            let row = &inventory.rows[0];
            assert_eq!(
                serde_json::to_value(&row.status).unwrap(),
                case["status"],
                "{}: {:?}",
                case["name"],
                row.issues
            );
            let issues: Vec<_> = row.issues.iter().map(|i| i.kind.as_str()).collect();
            for expected in case["issues"].as_array().unwrap() {
                assert!(
                    issues.contains(&expected.as_str().unwrap()),
                    "{}: {issues:?}",
                    case["name"]
                );
            }
            let original = row.original.as_ref().unwrap();
            assert_eq!(original.bytes, source.as_bytes());
            assert_eq!(
                original.sha256,
                crate::ledger::sha256_hex(source.as_bytes())
            );
            assert_eq!(std::fs::read(root.join(path)).unwrap(), original.bytes);
            assert!(row.proposed_id.is_none());
            if case["name"] == "BOM and CRLF" {
                assert_eq!(
                    &original.bytes[row.body_start.unwrap()..],
                    b"# Original title\r\nBody\r\n"
                );
            }
            if case["name"] == "moved Agent remains Agent" {
                assert_eq!(row.declared_type.as_deref(), Some("Agent"));
            }
            if case["name"] == "import stamps" {
                assert_eq!(row.import_stamps.len(), 3);
            }
        }
        assert!(!root.join(".cerebro/workspace-manifest.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_semantic_read_blocks_readiness_without_discarding_syntax_or_bytes() {
        let root = testutil::temp_vault("migration-semantic-read");
        let source = "---\nnumber: 18446744073709551616\nproject: \"[[Missing]]\"\n---\n# Body\n";
        testutil::write(&root, "large.md", source);
        let referring = "---\nproject: \"[[large]]\"\n---\n# Referring\n";
        testutil::write(&root, "referring.md", referring);
        let metadata = crate::vault::parse::split_frontmatter(source).0.unwrap();
        let (syntax, issues) = syntax_inventory(metadata).unwrap();
        assert!(issues.is_empty());
        assert!(crate::vault::parse::parse_frontmatter(metadata).is_err());

        let inventory = inventory_workspace(&root, &scope(&["large.md", "referring.md"])).unwrap();
        let row = &inventory.rows[0];
        let original = row.original.as_ref().unwrap();
        assert_eq!(original.bytes, source.as_bytes());
        assert_eq!(
            original.sha256,
            crate::ledger::sha256_hex(source.as_bytes())
        );
        assert_eq!(row.syntax.as_ref(), Some(&syntax));
        assert_eq!(
            std::fs::read(root.join("large.md")).unwrap(),
            source.as_bytes()
        );
        assert_eq!(row.status, Status::Blocked);
        assert!(row
            .issues
            .iter()
            .any(|issue| issue.kind == "semantic_read_unavailable"));
        assert!(row.proposed_id.is_none());
        let referring_row = &inventory.rows[1];
        assert_eq!(referring_row.status, Status::Ambiguous);
        assert!(referring_row
            .issues
            .iter()
            .any(|issue| issue.kind == "unresolved_relation"));
        assert_eq!(
            std::fs::read(root.join("referring.md")).unwrap(),
            referring.as_bytes()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn syntax_is_not_a_lossy_map_and_repeated_errors_release_the_parser() {
        for _ in 0..100 {
            assert!(syntax_inventory("x: [").is_err());
            let (node, issues) = syntax_inventory("x: 1\n\"x\": 2\n").unwrap();
            assert!(issues.iter().any(|i| i.kind == "duplicate_key"));
            let SyntaxNode::Mapping(rows) = node else {
                panic!("mapping")
            };
            assert_eq!(rows.len(), 2);
        }
        let (node, issues) = syntax_inventory("n: 9007199254740993.125\n").unwrap();
        assert!(issues.is_empty());
        assert!(format!("{node:?}").contains("9007199254740993.125"));
    }

    #[test]
    fn scope_refuses_traversal_duplicate_paths_symlinks_and_unknown_reads() {
        let root = testutil::temp_vault("migration-inventory-scope");
        testutil::write(&root, "visible.md", "# Visible\n");
        testutil::write(&root, "not-requested.md", "# Private\n");
        for paths in [
            vec!["../outside.md"],
            vec!["/absolute.md"],
            vec!["visible.md", "visible.md"],
        ] {
            assert!(inventory_workspace(&root, &scope(&paths)).is_err());
        }
        let inventory = inventory_workspace(&root, &scope(&["visible.md", "missing.md"])).unwrap();
        assert_eq!(inventory.rows.len(), 2);
        assert_eq!(inventory.coverage.kind, "requested_paths");
        assert_eq!(
            inventory.coverage.requested_paths,
            ["missing.md", "visible.md"]
        );
        assert!(!inventory.coverage.whole_vault);
        assert!(!inventory.coverage.conversion_attempted);
        assert!(!inventory.ledger.store_identity_in_scope);
        assert!(inventory.ledger.store_id.is_none());
        let missing = inventory
            .rows
            .iter()
            .find(|r| r.path == "missing.md")
            .unwrap();
        assert_eq!(missing.status, Status::Blocked);
        assert!(missing.original.is_none());
        assert!(missing.issues.iter().any(|i| i.kind == "read_unavailable"));
        #[cfg(unix)]
        {
            let outside = testutil::temp_vault("migration-inventory-outside");
            testutil::write(&outside, "outside.md", "# Outside\n");
            std::os::unix::fs::symlink(root.join("visible.md"), root.join("alias.md")).unwrap();
            std::os::unix::fs::symlink(outside.join("outside.md"), root.join("external.md"))
                .unwrap();
            std::os::unix::fs::symlink(&outside, root.join("linked-directory")).unwrap();
            for path in ["alias.md", "external.md", "linked-directory/outside.md"] {
                let row = &inventory_workspace(&root, &scope(&[path])).unwrap().rows[0];
                assert_eq!(row.status, Status::Blocked);
                assert!(row.original.is_none());
            }
            assert_eq!(
                std::fs::read(outside.join("outside.md")).unwrap(),
                b"# Outside\n"
            );
            let _ = std::fs::remove_dir_all(outside);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn byte_limits_and_invalid_text_never_turn_into_empty_sources() {
        let root = testutil::temp_vault("migration-inventory-limits");
        let bytes = [0xff, 0x00, 0x0d, 0x0a];
        std::fs::write(root.join("raw.md"), bytes).unwrap();
        let inventory = inventory_workspace(&root, &scope(&["raw.md"])).unwrap();
        let row = &inventory.rows[0];
        assert_eq!(row.status, Status::Blocked);
        assert!(row.issues.iter().any(|issue| issue.kind == "invalid_utf8"));
        assert_eq!(row.original.as_ref().unwrap().bytes, bytes);
        assert_eq!(std::fs::read(root.join("raw.md")).unwrap(), bytes);
        // Exercise the aggregate remainder without allocating a 128 MiB fixture.
        assert_eq!(
            read_original(&inventory.root, "raw.md", bytes.len() - 1)
                .unwrap_err()
                .kind,
            "source_limit"
        );
        let oversized = std::fs::File::create(root.join("large.md")).unwrap();
        oversized
            .set_len(limits().max_file_bytes as u64 + 1)
            .unwrap();
        let bounded = inventory_workspace(&root, &scope(&["large.md"])).unwrap();
        assert_eq!(bounded.rows[0].status, Status::Blocked);
        assert!(bounded.rows[0].original.is_none());
        assert!(bounded.rows[0]
            .issues
            .iter()
            .any(|issue| issue.kind == "source_limit"));
        let too_many = InventoryScope {
            paths: vec!["raw.md".into(); limits().max_files + 1],
        };
        assert_eq!(
            inventory_workspace(&root, &too_many).unwrap_err().kind,
            "source_limit"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn governed_bytes_and_ledger_identity_remain_separate_and_unwritten() {
        let root = testutil::temp_vault("migration-inventory-ledger");
        let concept = crate::ledger::project::project(
            "# Evidence\n",
            &serde_json::json!({"title":"Pinned", "verified": []}),
        );
        let store =
            r#"{"store_id":"existing-ledger-id","format":1,"created_at":"2026-10-23T00:00:00Z"}"#;
        testutil::write(&root, "knowledge/concept.md", &concept);
        testutil::write(&root, ".cerebro/ledger/store.json", store);
        testutil::write(
            &root,
            ".cerebro/projection-manifest.json",
            "{\"format\":2,\"entries\":{}}\n",
        );
        let paths = [
            "knowledge/concept.md",
            ".cerebro/ledger/store.json",
            ".cerebro/projection-manifest.json",
        ];
        let before: Vec<_> = paths
            .iter()
            .map(|p| std::fs::read(root.join(p)).unwrap())
            .collect();
        let inventory = inventory_workspace(&root, &scope(&paths)).unwrap();
        assert_eq!(
            inventory.ledger.store_id.as_deref(),
            Some("existing-ledger-id")
        );
        assert!(
            inventory.ledger.store_identity_in_scope
                && inventory.ledger.projection_manifest_in_scope
        );
        assert_eq!(
            inventory.ledger.projection_codec,
            "ledger/project.rs:okf-v0.2"
        );
        assert_eq!(
            inventory.ledger.projection_codec_sha256,
            crate::ledger::sha256_hex(include_bytes!("../ledger/project.rs"))
        );
        assert!(inventory.rows.iter().all(|r| r.status == Status::Retained));
        for (path, bytes) in paths.iter().zip(before) {
            assert_eq!(std::fs::read(root.join(path)).unwrap(), bytes);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn yaml_caps_bound_source_events_nesting_and_decoded_scalars() {
        let limits = &cases()["limits"];
        let max = limits["maxYamlBytes"].as_u64().unwrap() as usize;
        assert!(syntax_inventory(&format!("x: {}", "a".repeat(max))).is_err());
        let depth = limits["maxDepth"].as_u64().unwrap() as usize;
        assert!(syntax_inventory(&format!(
            "x: {}0{}",
            "[".repeat(depth + 1),
            "]".repeat(depth + 1)
        ))
        .is_err());
        assert!(syntax_inventory(&format!(
            "x: [{}]",
            vec!["0"; limits["maxEvents"].as_u64().unwrap() as usize].join(",")
        ))
        .is_err());
    }
}
