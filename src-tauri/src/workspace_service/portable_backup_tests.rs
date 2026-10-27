//! Behavioral RED for portable inactive backup/restore, using real native fixtures.
use super::*;
use crate::ledger::{self, arm::Arming, migrate::tests::WRITER};
use crate::vault::{comments, trash};
use crate::workspace_migration::{
    backup::{self, BackupError, BackupErrorKind},
    restore,
};
use rusqlite::{types::Value as SqlValue, OpenFlags};
use std::collections::BTreeMap;

const KNOWLEDGE: &str = "knowledge/systems/status-model.md";
const ATTACHMENT: &str = "attachments/data.bin";
const BODY_WITH_ATTACHMENT: &str =
    "\u{feff}---\r\nfull_width: false\r\n---\r\n# After\r\n\r\n[Attachment](attachments/data.bin)\r\n";
const TRASH_STAMP: &str = "20261024T120000Z-abcd";
const RECONCILE: &str = ".cerebro/reconcile-backup/retained-original.md";
const CONFIG: &str = crate::connectors::CONFIG_PATH;
const CONFIG_TEMP: &str = ".cerebro/.connectors.json.1234.7.tmp";
const SECRET: &[u8] = b"synthetic-private-connector-content-3357";
const HISTORY: &[u8] = b"synthetic-app-private-history-9418";

fn vocabulary() -> Value {
    serde_json::from_str(include_str!("../../../shared/workspace/export.v1.json")).unwrap()
}
fn limit(name: &str) -> u64 {
    backup::effective_limit_for_test(name)
}
fn put_bytes(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn file_tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    walkdir::WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .map(Result::unwrap)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            let rel = entry
                .path()
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            (rel, fs::read(entry.path()).unwrap())
        })
        .collect()
}
fn rows(conn: &Connection, sql: &str) -> Vec<Vec<SqlValue>> {
    let mut statement = conn.prepare(sql).unwrap();
    let count = statement.column_count();
    statement
        .query_map([], |row| (0..count).map(|index| row.get(index)).collect())
        .unwrap()
        .map(Result::unwrap)
        .collect()
}
fn database_facts(database: &Path) -> Vec<Vec<Vec<SqlValue>>> {
    let conn = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    vec![
        rows(&conn, "SELECT * FROM workspace ORDER BY singleton"),
        rows(&conn, "SELECT * FROM records ORDER BY id"),
        rows(&conn, "SELECT * FROM metadata_receipts ORDER BY epoch"),
    ]
}
#[derive(Debug, PartialEq)]
struct LedgerFacts {
    store: ledger::store::StoreInfo,
    head: ledger::LedgerHead,
    attestation: String,
    revision: String,
    manifest: ledger::manifest::Manifest,
}
fn ledger_facts(root: &Path) -> LedgerFacts {
    let classified = ledger::recovery::classify(&ledger::ledger_dir(root), Some(WRITER), None);
    assert_eq!(classified.verdict, ledger::recovery::Verdict::Valid);
    let read = classified.read.unwrap();
    assert!(matches!(&read.tail, ledger::segment::Tail::Clean));
    let state = ledger::reduce::reduce(&read.frames, &read.store.store_id);
    assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
    assert!(state.reconciliation_divergences.is_empty());
    assert_eq!(state.beliefs.len(), 1);
    let id = ledger::schema::migrate_id(&read.store.store_id, "belief", "systems/status-model.md");
    let belief = state.beliefs.get(&id).unwrap();
    let (attestation, revision) = belief.attested.clone().unwrap();
    assert_eq!(belief.attestation_events, vec![attestation.clone()]);
    assert_eq!(revision, belief.current().event_id);
    let projection = ledger::reduce::project_belief(&state, &id).unwrap();
    let manifest = ledger::manifest::load(root).unwrap().unwrap();
    assert_eq!(manifest.entries.len(), 1);
    assert_eq!(
        manifest.entries.get(KNOWLEDGE).unwrap(),
        &ledger::manifest::entry_for(&projection, ledger::manifest::WriteState::Complete, None)
    );
    assert_eq!(
        fs::read(root.join(KNOWLEDGE)).unwrap(),
        projection.bytes.as_bytes()
    );
    LedgerFacts {
        store: read.store,
        head: ledger::LedgerHead {
            seq: read.head_seq,
            hash: read.head_hash,
        },
        attestation,
        revision,
        manifest,
    }
}
struct PortableFixture {
    selected: Fixture,
    output: PathBuf,
    included: BTreeMap<String, Vec<u8>>,
    db_facts: Vec<Vec<Vec<SqlValue>>>,
    ledger_facts: LedgerFacts,
}
impl PortableFixture {
    fn new(label: &str) -> Self {
        Self::build(label, false)
    }
    fn with_pending_pair(label: &str) -> Self {
        Self::build(label, true)
    }
    fn build(label: &str, pending_pair: bool) -> Self {
        let f = fixture(&format!("portable-{label}"));
        let mut metadata = f.stored();
        metadata["value"]["exact"] = json!({"kind":"decimal","value":"9007199254740993.125"});
        metadata["value"]["unknown_key"] = json!({"kind":"object","value":{
            "nested_null":{"kind":"null"},
            "verbatim":{"kind":"string","value":"007"}
        }});
        metadata["value"]["unresolved"] = json!({"kind":"relation","spelling":"[[Unresolved]]",
            "fragment":null,"resolution":{"status":"unresolved"}});
        metadata["value"]["ambiguous"] = json!({"kind":"relation","spelling":"[[Ambiguous]]",
            "fragment":"fragment","resolution":{"status":"ambiguous"}});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![metadata.to_string(), RECORD],
            )
            .unwrap();
        put_bytes(&f.root, ATTACHMENT, &[0, 255, 128, 13, 10, 42]);
        f.run(|| {
            let before = f.version();
            assert!(matches!(
                replace(&f, &before, BODY_WITH_ATTACHMENT.as_bytes()).unwrap(),
                SelectedBodyAck::Applied { .. }
            ));
            assert!(matches!(
                mutate(&f, f.version(), SelectedMode::Default).unwrap(),
                SelectedMetadataAck::Applied {
                    full_width: false,
                    ..
                }
            ));
            assert_eq!(
                selected::read_body(&f.root, "page.md").unwrap(),
                BODY_WITH_ATTACHMENT
            );
        });
        assert_eq!(state(&f), (13, 5, 9));
        assert_eq!(receipt_count(&f), 2);
        let db_facts = database_facts(&f.db);
        // The actual paired writer must still see only supported paired pages.
        // Install this real pending intent before adding retained knowledge below.
        if pending_pair {
            let target = f.root.join("page.md");
            f.run(|| {
                let error = selected::with_before_install_for_test(
                    move || fs::write(target, b"# Outside while a real pair is pending\n").unwrap(),
                    || replace(&f, &f.version(), b"# Intended pending after-image\n"),
                )
                .unwrap_err();
                assert_eq!(error.kind, AuthorityErrorKind::RecoveryConflict);
            });
            assert!(f
                .db
                .parent()
                .unwrap()
                .join("pending-change/intent.json")
                .exists());
        }

        testutil::write(
            &f.root,
            KNOWLEDGE,
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../demo-vault/knowledge/systems/status-model.md"
            )),
        );
        let mut writer = ledger::writer::LedgerWriter::open(&f.root, WRITER).unwrap();
        match ledger::arm::arm(&mut writer, &f.root) {
            Arming::Migrated {
                outcome,
                manifest_created: true,
            } => {
                assert_eq!(outcome.replayed, 0);
                assert!(outcome.skipped_sources.is_empty());
                assert!(outcome.unresolved_relations.is_empty());
            }
            other => panic!("real fixture must arm cleanly: {other:?}"),
        }
        drop(writer);
        let ledger_facts = ledger_facts(&f.root);

        let discussion = comments::CommentsFile {
            format: comments::FORMAT,
            threads: vec![comments::Thread {
                anchor: None,
                resolved: None,
                deleted: None,
                comments: vec![comments::Comment {
                    id: "0123456789abcdef".into(),
                    author: comments::OWNER.into(),
                    created: "2026-10-24T12:00:00Z".into(),
                    body: "Retain this pending historical discussion.".into(),
                    deleted: None,
                    run_id: Some("historical-run-not-resumable".into()),
                    state: Some(comments::CommentState::Pending),
                    answers: None,
                }],
            }],
        };
        let discussion_text = comments::serialize_comments(&discussion);
        assert_eq!(
            comments::parse_comments(&discussion_text).unwrap(),
            discussion
        );
        testutil::write(&f.root, &comments::sidecar_rel("page.md"), &discussion_text);

        assert!(trash::parse_stamp(TRASH_STAMP).is_some());
        let trash_manifest = trash::Manifest {
            format: trash::MANIFEST_FORMAT,
            path: "discarded.md".into(),
            kind: trash::TrashKind::File,
            title: "Discarded".into(),
            deleted_at: "2026-10-24T12:00:00Z".into(),
        };
        let trash_text = trash::manifest_bytes(&trash_manifest);
        assert_eq!(trash::parse_manifest(&trash_text), Some(trash_manifest));
        testutil::write(&f.root, &trash::manifest_rel(TRASH_STAMP), &trash_text);
        testutil::write(
            &f.root,
            &format!("{}/discarded.md", trash::stamp_rel(TRASH_STAMP)),
            "# Discarded\r\n",
        );
        testutil::write(
            &f.root,
            &format!(
                "{}/{}",
                trash::stamp_rel(TRASH_STAMP),
                comments::sidecar_rel("discarded.md")
            ),
            &discussion_text,
        );
        testutil::write(&f.root, RECONCILE, "# Displaced human bytes\r\n");
        testutil::write(
            &f.root,
            ".claude/agents/retained.md",
            "# Retained standing instructions\n",
        );
        testutil::write(
            &f.root,
            ".cerebro/unknown-retained.bin",
            "opaque retained carrier",
        );
        // This user directory is NOT the installed metadata archive namespace.
        testutil::write(
            &f.root,
            "originals/.cerebro/connectors.json",
            "ordinary nested user carrier",
        );

        let mut included = file_tree(&f.root);
        included.remove(".cerebro/workspace-format.json");
        included.remove(&format!("{}/lock", ledger::LEDGER_DIR));

        put_bytes(&f.root, CONFIG, SECRET);
        put_bytes(&f.root, CONFIG_TEMP, SECRET);
        put_bytes(&f.root, ".cerebro/runtime.db", HISTORY);
        let old_manifest = json!({
            "format":1,
            "source":"/historical/source/root",
            "inventory":[{"path":CONFIG,"kind":"file","exclusion":null,
                "bytes":SECRET.len(),"hash":ledger::sha256_hex(SECRET)}]
        });
        testutil::write(
            &f.root,
            ".cerebro/staged-manifest.json",
            &old_manifest.to_string(),
        );
        let original_root = f.db.parent().unwrap().join("originals");
        put_bytes(&original_root, "page.md", BEFORE.as_bytes());
        put_bytes(&original_root, CONFIG, SECRET);
        put_bytes(&original_root, CONFIG_TEMP, SECRET);
        put_bytes(
            &original_root,
            ".cerebro/connectors.json.notes",
            b"retain neighboring original",
        );
        put_bytes(
            &original_root,
            ".cerebro/staged-manifest.json",
            old_manifest.to_string().as_bytes(),
        );

        // Out-of-scope app-private bytes are synthetic; touching them is a failure.
        put_bytes(&f.origin, "runtime.db", HISTORY);
        put_bytes(&f.origin, "recovery/recovery.sqlite", HISTORY);
        put_bytes(&f.origin, "sessions/recorded-chat.json", HISTORY);
        let output = testutil::temp_vault(&format!("portable-output-{label}"));
        Self {
            selected: f,
            output,
            included,
            db_facts,
            ledger_facts,
        }
    }
    fn bundle(&self) -> PathBuf {
        self.output.join("bundle")
    }
    fn export(&self) -> PathBuf {
        let bundle = self.bundle();
        let report = self
            .selected
            .run(|| backup::backup_workspace(&self.selected.root, &bundle))
            .expect("real complete backup must be available");
        assert_eq!(report.workspace_id, WORKSPACE);
        backup::validate_backup(&bundle).expect("new bundle must independently validate");
        let manifest = read_manifest(&bundle);
        assert_eq!(manifest["state"], "complete");
        assert_eq!(manifest["workspace_id"], WORKSPACE);
        assert_eq!(manifest["metadata_epoch"], "13");
        assert_eq!(manifest["schema_revision"], "5");
        assert_eq!(manifest["schema_version"], 3);
        self.selected.run(|| {
            assert_eq!(
                selected::scan(&self.selected.root).unwrap_err().kind,
                AuthorityErrorKind::MetadataUnavailable,
                "passive export must not grant the unsupported live carrier read"
            );
        });
        bundle
    }
}
impl Drop for PortableFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.output);
    }
}
fn read_manifest(bundle: &Path) -> Value {
    serde_json::from_slice(&fs::read(bundle.join("manifest.json")).unwrap()).unwrap()
}
fn write_manifest(bundle: &Path, manifest: &Value) {
    fs::write(
        bundle.join("manifest.json"),
        serde_json::to_vec(manifest).unwrap(),
    )
    .unwrap();
}
fn part_file(bundle: &Path, part: &Value) -> PathBuf {
    let root = match part["namespace"].as_str().unwrap() {
        "bodies" => bundle.join("bodies"),
        "metadata" => bundle.join("metadata"),
        "originals" => bundle.join("metadata/originals"),
        other => panic!("unexpected namespace {other}"),
    };
    root.join(part["path"].as_str().unwrap())
}
fn part_mut<'a>(manifest: &'a mut Value, namespace: &str, path: &str) -> &'a mut Value {
    manifest["parts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|part| part["namespace"] == namespace && part["path"] == path)
        .unwrap()
}
fn assert_refusal(error: BackupError, expected: BackupErrorKind) {
    assert_eq!(error.code, "capability_unavailable");
    assert_eq!(error.kind, expected);
    assert!(!error.message.is_empty());
}
fn assert_no_ready(root: &Path) {
    let marker = root.join(".cerebro/workspace-format.json");
    if let Ok(bytes) = fs::read(marker) {
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_ne!(value["state"], "restored_inactive");
        assert_ne!(value["state"], "activated");
    }
}
fn assert_restore_refused(bundle: &Path, output: &Path, kind: BackupErrorKind) {
    let bodies = output.join("bodies");
    let metadata = output.join("metadata");
    assert_refusal(
        restore::restore_workspace(bundle, &bodies, &metadata).unwrap_err(),
        kind,
    );
    assert_no_ready(&bodies);
    assert!(!metadata.join("bindings.v1.json").exists());
}

#[test]
fn portable_fixture_has_actual_post_edit_receipts_and_an_applied_original_attestation() {
    let p = PortableFixture::new("fixture-health");
    assert_eq!(p.db_facts[0][0][4], SqlValue::Integer(13));
    assert_eq!(p.db_facts[2].len(), 2);
    assert!(p.ledger_facts.head.seq.is_some());
    assert!(!p.ledger_facts.attestation.is_empty());
    assert_eq!(
        fs::read(p.selected.root.join("page.md")).unwrap(),
        BODY_WITH_ATTACHMENT.as_bytes()
    );
    assert_eq!(p.selected.stored()["value"]["code"]["value"], "007");
    assert_eq!(
        p.selected.stored()["value"]["exact"]["value"],
        "9007199254740993.125"
    );
    assert!(!p
        .selected
        .db
        .parent()
        .unwrap()
        .join("pending-change")
        .exists());
    // A passive export must not widen this existing live authority boundary.
    p.selected.run(|| {
        assert_eq!(
            selected::scan(&p.selected.root).unwrap_err().kind,
            AuthorityErrorKind::MetadataUnavailable
        );
        assert_eq!(authority::context().unwrap().active_root().unwrap(), None);
    });
    assert!(!p.bundle().exists());
}

#[test]
fn portable_restore_survives_missing_source_and_preserves_post_edit_pairs_and_attestations() {
    let p = PortableFixture::new("roundtrip");
    let root_before = file_tree(&p.selected.root);
    let origin_before = file_tree(&p.selected.origin);
    let bundle = p.export();
    assert_eq!(file_tree(&p.selected.root), root_before);
    assert_eq!(file_tree(&p.selected.origin), origin_before);
    assert!(!fs::read_to_string(bundle.join("manifest.json"))
        .unwrap()
        .contains(p.selected.root.to_str().unwrap()));

    let captured_database = fs::read(bundle.join("metadata/workspace.db")).unwrap();
    assert_eq!(
        database_facts(&bundle.join("metadata/workspace.db")),
        p.db_facts
    );
    fs::rename(&p.selected.root, p.output.join("removed-source-root")).unwrap();
    fs::rename(
        p.selected.db.parent().unwrap(),
        p.output.join("removed-source-metadata"),
    )
    .unwrap();
    assert!(!p.selected.root.exists());
    assert!(!p.selected.db.exists());
    let remaining_origin = file_tree(&p.selected.origin);
    let bodies = p.output.join("restored-bodies");
    let metadata = p.output.join("restored-metadata");
    p.selected.run(|| {
        let context = authority::context().unwrap();
        let agents = crate::agent::AgentState::default();
        let report = restore::restore_workspace(&bundle, &bodies, &metadata).unwrap();
        assert_eq!(report.workspace_id, WORKSPACE);
        assert_eq!(context.active_root().unwrap(), None);
        // Passive restore cannot mutate an unrelated standalone AgentState.
        // First exercise the actual native gate, which precedes start_watcher
        // and run_agent. The marker must refuse before either handler executes.
        for command in ["start_watcher", "run_agent"] {
            let called = std::cell::Cell::new(false);
            let request = crate::workspace_service::native_admission::request(
                command,
                &tauri::ipc::InvokeBody::Json(json!({"vault": bodies})),
            )
            .unwrap();
            let error = crate::workspace_service::native_admission::dispatch_checked(
                &context,
                request,
                || called.set(true),
            )
            .unwrap_err();
            assert_eq!(error.kind, AuthorityErrorKind::InvalidFormat);
            assert!(!called.get(), "{command} reached its handler");
        }
        // Exercise start_watcher's internal opening sequence too. A refused
        // restored root must never reach either legacy or selected publication.
        let generation = context.begin_open().unwrap();
        agents.begin_open(generation).unwrap();
        assert_eq!(
            authority::resolve(&bodies).unwrap_err().kind,
            AuthorityErrorKind::InvalidFormat
        );
        assert_eq!(
            crate::prepare_selected_open(&bodies).unwrap_err().kind,
            AuthorityErrorKind::InvalidFormat
        );
        let bound = std::cell::Cell::new(false);
        assert_eq!(
            crate::finish_legacy_open(&context, generation, &bodies, &agents, || bound.set(true))
                .unwrap_err()
                .kind,
            AuthorityErrorKind::InvalidFormat
        );
        assert!(!bound.get(), "restored root published a legacy binding");
        assert_eq!(
            context.publish_open(generation, &bodies).unwrap_err().kind,
            AuthorityErrorKind::InvalidFormat
        );
        assert_eq!(context.active_root().unwrap(), None);
        assert!(agents.prepare_run(&bodies).is_err());
        assert!(authority::guard_legacy(&bodies).is_err());
        assert!(selected::read_body(&bodies, "page.md").is_err());
    });
    assert_eq!(file_tree(&p.selected.origin), remaining_origin);
    assert_eq!(
        fs::read(metadata.join("workspace.db")).unwrap(),
        captured_database
    );
    assert_eq!(database_facts(&metadata.join("workspace.db")), p.db_facts);
    assert_eq!(ledger_facts(&bodies), p.ledger_facts);
    for (path, bytes) in &p.included {
        assert_eq!(fs::read(bodies.join(path)).unwrap(), *bytes, "{path}");
    }
    assert_eq!(
        fs::read(metadata.join("originals/page.md")).unwrap(),
        BEFORE.as_bytes()
    );
    assert!(!bodies.join("discarded.md").exists());
    assert!(!metadata.join("bindings.v1.json").exists());
    assert!(!metadata.join("selected.lock").exists());
    let marker: Value =
        serde_json::from_slice(&fs::read(bodies.join(".cerebro/workspace-format.json")).unwrap())
            .unwrap();
    assert_eq!(marker["state"], "restored_inactive");
    assert!(crate::workspace_migration::format_gate::guard_legacy_access(&bodies).is_err());
}

#[test]
fn portable_backup_excludes_historical_secrets_and_reports_every_omitted_namespace() {
    let p = PortableFixture::new("historical-secrets");
    let root_before = file_tree(&p.selected.root);
    let origin_before = file_tree(&p.selected.origin);
    let bundle = p.export();
    let manifest = read_manifest(&bundle);
    let exclusions = manifest["exclusions"].as_array().unwrap();
    for namespace in ["bodies", "originals"] {
        for path in [CONFIG, CONFIG_TEMP] {
            let row = exclusions
                .iter()
                .find(|row| row["namespace"] == namespace && row["path"] == path)
                .expect("each live/archive omission must be named");
            assert_eq!(row["reason"], "private_credentials");
            assert!(row.get("bytes").is_none_or(Value::is_null));
            assert!(row.get("hash").is_none_or(Value::is_null));
        }
        assert!(exclusions.iter().any(|row| row["namespace"] == namespace
            && row["path"] == ".cerebro/staged-manifest.json"
            && row["reason"] == "source_control_artifact"));
    }
    for scope in vocabulary()["omitted_scopes"].as_array().unwrap() {
        assert!(manifest["omitted_scopes"]
            .as_array()
            .unwrap()
            .contains(scope));
    }
    let secret_hash = ledger::sha256_hex(SECRET);
    for (path, bytes) in file_tree(&bundle) {
        assert!(
            !bytes.windows(SECRET.len()).any(|window| window == SECRET),
            "{path}"
        );
        assert!(
            !bytes.windows(HISTORY.len()).any(|window| window == HISTORY),
            "{path}"
        );
        assert!(
            !bytes
                .windows(secret_hash.len())
                .any(|window| window == secret_hash.as_bytes()),
            "{path}"
        );
    }
    assert_eq!(
        fs::read(bundle.join("bodies/originals/.cerebro/connectors.json")).unwrap(),
        b"ordinary nested user carrier"
    );
    assert_eq!(
        fs::read(bundle.join("metadata/originals/.cerebro/connectors.json.notes")).unwrap(),
        b"retain neighboring original"
    );
    let bodies = p.output.join("restored-bodies");
    let metadata = p.output.join("restored-metadata");
    restore::restore_workspace(&bundle, &bodies, &metadata).unwrap();
    for path in [
        CONFIG,
        CONFIG_TEMP,
        ".cerebro/runtime.db",
        ".cerebro/staged-manifest.json",
    ] {
        assert!(!bodies.join(path).exists(), "{path}");
    }
    for path in [CONFIG, CONFIG_TEMP, ".cerebro/staged-manifest.json"] {
        assert!(!metadata.join("originals").join(path).exists(), "{path}");
    }
    assert_eq!(file_tree(&p.selected.root), root_before);
    assert_eq!(file_tree(&p.selected.origin), origin_before);
}

#[test]
fn portable_restore_refuses_missing_or_corrupt_required_parts_before_ready_publication() {
    let p = PortableFixture::new("required-parts");
    let bundle = p.export();
    let manifest = read_manifest(&bundle);
    let ledger_segment = manifest["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|part| {
            part["namespace"] == "bodies"
                && part["path"].as_str().is_some_and(|path| {
                    path.starts_with(ledger::LEDGER_DIR) && path.ends_with(".open")
                })
        })
        .unwrap()["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let required = [
        ("metadata", "workspace.db".to_owned()),
        ("bodies", "page.md".to_owned()),
        ("bodies", ATTACHMENT.to_owned()),
        ("bodies", KNOWLEDGE.to_owned()),
        ("bodies", comments::sidecar_rel("page.md")),
        ("bodies", format!("{}/store.json", ledger::LEDGER_DIR)),
        ("bodies", ledger_segment),
        ("bodies", ledger::manifest::MANIFEST_PATH.to_owned()),
        ("bodies", trash::manifest_rel(TRASH_STAMP)),
        ("bodies", RECONCILE.to_owned()),
        ("originals", "page.md".to_owned()),
    ];
    for (index, (namespace, rel)) in required.iter().enumerate() {
        let part = manifest["parts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|part| part["namespace"] == *namespace && part["path"] == *rel)
            .unwrap();
        let physical = part_file(&bundle, part);
        let original = fs::read(&physical).unwrap();
        let saved = p.output.join(format!("removed-part-{index}"));
        fs::rename(&physical, &saved).unwrap();
        assert_restore_refused(
            &bundle,
            &p.output.join(format!("missing-{index}")),
            BackupErrorKind::RequiredPartMissing,
        );
        fs::rename(&saved, &physical).unwrap();
        let mut corrupted = original.clone();
        corrupted[0] ^= 1;
        fs::write(&physical, corrupted).unwrap();
        assert_restore_refused(
            &bundle,
            &p.output.join(format!("corrupt-{index}")),
            BackupErrorKind::PartMismatch,
        );
        fs::write(&physical, original).unwrap();
    }
    backup::validate_backup(&bundle).unwrap();
}

#[test]
fn portable_matching_outer_hashes_do_not_authorize_invalid_metadata_or_ledger() {
    for corrupt_ledger in [false, true] {
        let p = PortableFixture::new(if corrupt_ledger {
            "invalid-ledger"
        } else {
            "invalid-metadata"
        });
        let bundle = p.export();
        let mut manifest = read_manifest(&bundle);
        let (namespace, relative, expected) = if corrupt_ledger {
            let relative = manifest["parts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|part| {
                    part["namespace"] == "bodies"
                        && part["path"].as_str().is_some_and(|path| {
                            path.starts_with(ledger::LEDGER_DIR) && path.ends_with(".open")
                        })
                })
                .unwrap()["path"]
                .as_str()
                .unwrap()
                .to_owned();
            let file = bundle.join("bodies").join(&relative);
            let mut bytes = fs::read(&file).unwrap();
            bytes.extend_from_slice(b"{\"not\":\"a ledger frame\"}\n");
            fs::write(file, bytes).unwrap();
            ("bodies", relative, BackupErrorKind::InvalidLedger)
        } else {
            let db = bundle.join("metadata/workspace.db");
            let conn = Connection::open(&db).unwrap();
            conn.execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![
                    r#"{"kind":"future_unknown_kind","value":"must refuse"}"#,
                    RECORD
                ],
            )
            .unwrap();
            drop(conn);
            (
                "metadata",
                "workspace.db".into(),
                BackupErrorKind::InvalidMetadata,
            )
        };
        let part = part_mut(&mut manifest, namespace, &relative);
        let bytes = fs::read(part_file(&bundle, part)).unwrap();
        part["bytes"] = json!(bytes.len().to_string());
        part["hash"] = json!(ledger::sha256_hex(&bytes));
        write_manifest(&bundle, &manifest);
        assert_restore_refused(&bundle, &p.output.join("rejected"), expected);
    }
}

#[test]
fn portable_source_refusals_never_recover_adopt_or_drop_required_content() {
    for scenario in [
        "pending",
        "body-drift",
        "unpaired-body",
        "missing-attachment",
        "unknown-metadata",
        "missing-ledger-store",
        "torn-ledger",
    ] {
        let p = if scenario == "pending" {
            PortableFixture::with_pending_pair(scenario)
        } else {
            PortableFixture::new(scenario)
        };
        let expected = match scenario {
            "pending" => BackupErrorKind::RecoveryRequired,
            "body-drift" => {
                fs::write(
                    p.selected.root.join("page.md"),
                    b"# Outside unacknowledged body\n",
                )
                .unwrap();
                BackupErrorKind::SourceChanged
            }
            "unpaired-body" => {
                testutil::write(
                    &p.selected.root,
                    "unowned-ordinary.md",
                    "# No canonical identity\n",
                );
                BackupErrorKind::RequiredPartMissing
            }
            "missing-ledger-store" => {
                fs::remove_file(ledger::ledger_dir(&p.selected.root).join("store.json")).unwrap();
                BackupErrorKind::InvalidLedger
            }
            "torn-ledger" => {
                let read = ledger::read_ledger(&ledger::ledger_dir(&p.selected.root)).unwrap();
                let last = read.segments.last().unwrap().file_name();
                let mut file = fs::OpenOptions::new()
                    .append(true)
                    .open(ledger::ledger_dir(&p.selected.root).join(last))
                    .unwrap();
                std::io::Write::write_all(&mut file, b"{partial unacknowledged ledger frame")
                    .unwrap();
                drop(file);
                assert!(matches!(
                    ledger::read_ledger(&ledger::ledger_dir(&p.selected.root))
                        .unwrap()
                        .tail,
                    ledger::segment::Tail::Torn { .. }
                ));
                BackupErrorKind::InvalidLedger
            }
            "missing-attachment" => {
                fs::remove_file(p.selected.root.join(ATTACHMENT)).unwrap();
                BackupErrorKind::RequiredPartMissing
            }
            "unknown-metadata" => {
                p.selected
                    .conn()
                    .execute(
                        "UPDATE records SET metadata=?1 WHERE id=?2",
                        rusqlite::params![
                            r#"{"kind":"future_unknown_kind","value":"must refuse"}"#,
                            RECORD
                        ],
                    )
                    .unwrap();
                BackupErrorKind::InvalidMetadata
            }
            _ => unreachable!(),
        };
        let root_before = file_tree(&p.selected.root);
        let origin_before = file_tree(&p.selected.origin);
        let error = p
            .selected
            .run(|| backup::backup_workspace(&p.selected.root, &p.bundle()))
            .unwrap_err();
        assert_refusal(error, expected);
        assert_eq!(file_tree(&p.selected.root), root_before);
        assert_eq!(file_tree(&p.selected.origin), origin_before);
        assert!(!p.bundle().join("manifest.json").exists());
    }
}

#[test]
fn portable_manifest_rejects_escaping_aliasing_and_undeclared_paths_before_copy() {
    let p = PortableFixture::new("hostile-paths");
    let bundle = p.export();
    let clean = read_manifest(&bundle);
    for (index, path) in [
        "../outside",
        "/absolute",
        "",
        "./page.md",
        "folder//page.md",
    ]
    .iter()
    .enumerate()
    {
        let mut manifest = clean.clone();
        part_mut(&mut manifest, "bodies", "page.md")["path"] = json!(path);
        write_manifest(&bundle, &manifest);
        assert_restore_refused(
            &bundle,
            &p.output.join(format!("path-{index}")),
            BackupErrorKind::InvalidPath,
        );
    }
    for (index, aliases) in [
        vec!["case-peer.md", "CASE-PEER.MD"],
        vec!["fold-peer.md", "fo\u{200c}ld-peer.md"],
        vec!["caf\u{e9}.md", "cafe\u{301}.md"],
        vec!["entry", "entry/child"],
    ]
    .iter()
    .enumerate()
    {
        let mut manifest = clean.clone();
        let template = part_mut(&mut manifest, "bodies", "page.md").clone();
        for alias in aliases {
            let mut part = template.clone();
            part["path"] = json!(alias);
            manifest["parts"].as_array_mut().unwrap().push(part);
        }
        write_manifest(&bundle, &manifest);
        assert_restore_refused(
            &bundle,
            &p.output.join(format!("alias-{index}")),
            BackupErrorKind::InvalidPath,
        );
    }
    let mut unknown = clean.clone();
    unknown["unrecognized_authority"] = json!({"allow":true});
    write_manifest(&bundle, &unknown);
    assert_restore_refused(
        &bundle,
        &p.output.join("unknown-field"),
        BackupErrorKind::InvalidManifest,
    );
    let mut unknown_part = clean.clone();
    part_mut(&mut unknown_part, "bodies", "page.md")["unrecognized_authority"] = json!(true);
    write_manifest(&bundle, &unknown_part);
    assert_restore_refused(
        &bundle,
        &p.output.join("unknown-part-field"),
        BackupErrorKind::InvalidManifest,
    );
    let mut unknown_namespace = clean.clone();
    part_mut(&mut unknown_namespace, "bodies", "page.md")["namespace"] =
        json!("app_private_authority");
    write_manifest(&bundle, &unknown_namespace);
    assert_restore_refused(
        &bundle,
        &p.output.join("unknown-namespace"),
        BackupErrorKind::InvalidManifest,
    );
    for (field, value) in [
        (
            "workspace_id",
            json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ),
        ("metadata_epoch", json!("14")),
        ("schema_revision", json!("6")),
        ("schema_version", json!(2)),
    ] {
        let mut mismatch = clean.clone();
        mismatch[field] = value;
        write_manifest(&bundle, &mismatch);
        assert_restore_refused(
            &bundle,
            &p.output.join(format!("mismatch-{field}")),
            BackupErrorKind::InvalidMetadata,
        );
    }
    write_manifest(&bundle, &clean);
    put_bytes(&bundle, "bodies/undeclared.bin", b"not in manifest");
    assert_restore_refused(
        &bundle,
        &p.output.join("undeclared"),
        BackupErrorKind::InvalidManifest,
    );
    assert!(!p.output.join("outside").exists());
}

#[test]
fn portable_size_count_and_depth_limits_precede_materialization() {
    let p = PortableFixture::new("hostile-limits");
    let bundle = p.export();
    let clean = read_manifest(&bundle);
    let mut declared = clean.clone();
    part_mut(&mut declared, "bodies", "page.md")["bytes"] =
        json!((limit("file_bytes") + 1).to_string());
    write_manifest(&bundle, &declared);
    assert_restore_refused(
        &bundle,
        &p.output.join("declared"),
        BackupErrorKind::SourceLimit,
    );

    let mut depth = clean.clone();
    part_mut(&mut depth, "bodies", "page.md")["path"] = json!(format!(
        "{}page.md",
        "d/".repeat(limit("depth") as usize + 1)
    ));
    write_manifest(&bundle, &depth);
    assert_restore_refused(
        &bundle,
        &p.output.join("depth"),
        BackupErrorKind::SourceLimit,
    );

    let mut count = clean.clone();
    let template = part_mut(&mut count, "bodies", "page.md").clone();
    for index in 0..=limit("entries") {
        let mut part = template.clone();
        part["path"] = json!(format!("bounded/{index}.bin"));
        count["parts"].as_array_mut().unwrap().push(part);
    }
    write_manifest(&bundle, &count);
    assert_restore_refused(
        &bundle,
        &p.output.join("count"),
        BackupErrorKind::SourceLimit,
    );

    write_manifest(&bundle, &clean);
    let page = bundle.join("bodies/page.md");
    let original = fs::read(&page).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&page)
        .unwrap()
        .set_len(limit("file_bytes") + 1)
        .unwrap();
    assert_restore_refused(
        &bundle,
        &p.output.join("actual-size"),
        BackupErrorKind::SourceLimit,
    );
    fs::write(page, original).unwrap();

    fs::OpenOptions::new()
        .write(true)
        .open(bundle.join("manifest.json"))
        .unwrap()
        .set_len(limit("manifest_bytes") + 1)
        .unwrap();
    assert_restore_refused(
        &bundle,
        &p.output.join("manifest-size"),
        BackupErrorKind::SourceLimit,
    );
}

#[test]
fn portable_input_links_and_regular_archives_never_escape_or_extract() {
    use std::os::unix::fs::symlink;
    let p = PortableFixture::new("hostile-files");
    let bundle = p.export();
    let outside = p.output.join("outside-sentinel");
    fs::write(&outside, b"outside untouched").unwrap();
    let body = bundle.join("bodies/page.md");
    let original = fs::read(&body).unwrap();
    fs::remove_file(&body).unwrap();
    symlink(&outside, &body).unwrap();
    assert_restore_refused(
        &bundle,
        &p.output.join("symlink"),
        BackupErrorKind::InvalidPath,
    );
    fs::remove_file(&body).unwrap();
    fs::hard_link(&outside, &body).unwrap();
    assert_restore_refused(
        &bundle,
        &p.output.join("hardlink"),
        BackupErrorKind::InvalidPath,
    );
    fs::remove_file(&body).unwrap();
    fs::write(body, original).unwrap();
    for (name, bytes) in [
        ("archive.zip", b"PK\x03\x04".as_slice()),
        ("archive.tar", b"ustar".as_slice()),
    ] {
        let archive = p.output.join(name);
        fs::write(&archive, bytes).unwrap();
        assert_restore_refused(
            &archive,
            &p.output.join(name.replace('.', "-")),
            BackupErrorKind::UnsupportedContainer,
        );
    }
    assert_eq!(fs::read(outside).unwrap(), b"outside untouched");
}

#[test]
fn portable_restore_never_overwrites_existing_or_overlapping_destinations() {
    let p = PortableFixture::new("destinations");
    let bundle = p.export();
    let existing = p.output.join("existing");
    put_bytes(&existing, "sentinel", b"keep existing destination");
    assert_refusal(
        restore::restore_workspace(&bundle, &existing, &p.output.join("new-metadata")).unwrap_err(),
        BackupErrorKind::DestinationUnavailable,
    );
    assert_eq!(
        file_tree(&existing),
        BTreeMap::from([("sentinel".into(), b"keep existing destination".to_vec())])
    );
    assert!(!p.output.join("new-metadata").exists());
    let shared = p.output.join("same-root");
    assert_refusal(
        restore::restore_workspace(&bundle, &shared, &shared).unwrap_err(),
        BackupErrorKind::DestinationUnavailable,
    );
    assert!(!shared.exists());
    let nested = bundle.join("restore-inside-input");
    assert_refusal(
        restore::restore_workspace(&bundle, &nested, &p.output.join("nested-metadata"))
            .unwrap_err(),
        BackupErrorKind::DestinationUnavailable,
    );
    assert!(!nested.exists());
    let root_before = file_tree(&p.selected.root);
    let origin_before = file_tree(&p.selected.origin);
    assert_refusal(
        restore::restore_workspace(&bundle, &p.selected.root, &p.selected.origin).unwrap_err(),
        BackupErrorKind::DestinationUnavailable,
    );
    assert_eq!(file_tree(&p.selected.root), root_before);
    assert_eq!(file_tree(&p.selected.origin), origin_before);
}

#[test]
fn portable_backup_respects_both_existing_locks_without_relabeling_or_waiting() {
    let p = PortableFixture::new("busy-owners");
    let selected_lock = p.selected.db.parent().unwrap().join("selected.lock");
    let ledger_lock = ledger::ledger_dir(&p.selected.root).join("lock");
    for lock_path in [selected_lock, ledger_lock] {
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        lock.try_lock().unwrap();
        let root_before = file_tree(&p.selected.root);
        let origin_before = file_tree(&p.selected.origin);
        let start = Instant::now();
        let error = p
            .selected
            .run(|| backup::backup_workspace(&p.selected.root, &p.bundle()))
            .unwrap_err();
        assert_refusal(error, BackupErrorKind::Busy);
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "backup must not wait for a live owner"
        );
        assert_eq!(file_tree(&p.selected.root), root_before);
        assert_eq!(file_tree(&p.selected.origin), origin_before);
        assert!(!p.bundle().exists());
        drop(lock);
    }
}

// GREEN regressions: derive support caps from the same compiled authorities.
#[test]
fn portable_accepted_ten_mib_and_exact_canonical_limit_survive_real_paired_roundtrips() {
    let authority: Value =
        serde_json::from_str(include_str!("../../../shared/workspace/authority.v2.json")).unwrap();
    let max = authority["limits"]["bodyBytes"].as_u64().unwrap();
    assert_eq!(limit("body_bytes"), max);
    for size in [10 * 1024 * 1024, max] {
        let f = fixture(&format!("portable-large-{size}"));
        let output = testutil::temp_vault(&format!("portable-large-output-{size}"));
        let body = vec![b'x'; size as usize];
        f.run(|| {
            assert!(matches!(
                replace(&f, &f.version(), &body).unwrap(),
                SelectedBodyAck::Applied { .. }
            ));
        });
        let exact = database_facts(&f.db);
        let source = fs::read(&f.db).unwrap();
        let bundle = output.join("bundle");
        f.run(|| backup::backup_workspace(&f.root, &bundle))
            .unwrap();
        let bodies = output.join("restored");
        let metadata = output.join("metadata");
        restore::restore_workspace(&bundle, &bodies, &metadata).unwrap();
        assert_eq!(fs::read(bodies.join("page.md")).unwrap(), body);
        assert_eq!(database_facts(&metadata.join("workspace.db")), exact);
        assert_eq!(fs::read(&f.db).unwrap(), source);
        assert_eq!(receipt_count(&f), 1);
        assert!(!metadata.join("selected.lock").exists());
        let marker: Value = serde_json::from_slice(
            &fs::read(bodies.join(".cerebro/workspace-format.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(marker["state"], "restored_inactive");
        fs::remove_dir_all(output).unwrap();
    }
}

#[test]
fn portable_actual_source_body_max_plus_one_refuses_before_hash_or_writer() {
    let f = fixture("portable-body-limit-plus-one");
    let output = testutil::temp_vault("portable-body-limit-output");
    fs::OpenOptions::new()
        .write(true)
        .open(f.root.join("page.md"))
        .unwrap()
        .set_len(limit("body_bytes") + 1)
        .unwrap();
    let before = fs::read(&f.db).unwrap();
    let error = f
        .run(|| backup::backup_workspace(&f.root, &output.join("bundle")))
        .unwrap_err();
    assert_refusal(error, BackupErrorKind::SourceLimit);
    assert_eq!(fs::read(&f.db).unwrap(), before);
    assert_eq!(receipt_count(&f), 0);
    assert!(!output.join("bundle/manifest.json").exists());
    assert_eq!(
        fs::metadata(f.root.join("page.md")).unwrap().len(),
        limit("body_bytes") + 1
    );
    fs::remove_dir_all(output).unwrap();
}

#[test]
fn portable_native_attachment_limit_is_retained_beyond_original_staging_cap() {
    let f = fixture("portable-attachment-cap");
    let output = testutil::temp_vault("portable-attachment-cap-output");
    let size = crate::files::kinds::limits().attachment_bytes;
    assert!(limit("retained_bytes") >= size);
    assert!(size > 8 * 1024 * 1024);
    put_bytes(&f.root, ATTACHMENT, b"retained binary prefix");
    fs::OpenOptions::new()
        .write(true)
        .open(f.root.join(ATTACHMENT))
        .unwrap()
        .set_len(size)
        .unwrap();
    f.run(|| {
        replace(&f, &f.version(), b"[Original](attachments/data.bin)\n").unwrap();
    });
    let bundle = output.join("bundle");
    f.run(|| backup::backup_workspace(&f.root, &bundle))
        .unwrap();
    let bodies = output.join("restored");
    restore::restore_workspace(&bundle, &bodies, &output.join("metadata")).unwrap();
    assert_eq!(fs::metadata(bodies.join(ATTACHMENT)).unwrap().len(), size);
    assert_eq!(
        ledger::sha256_hex(&fs::read(bodies.join(ATTACHMENT)).unwrap()),
        ledger::sha256_hex(&fs::read(f.root.join(ATTACHMENT)).unwrap())
    );
    fs::remove_dir_all(output).unwrap();
}

#[test]
fn portable_dependency_carriers_reuse_nested_encoded_fragment_and_fenced_media_grammar() {
    let f = fixture("portable-media-grammar");
    let output = testutil::temp_vault("portable-media-grammar-output");
    for path in [
        "attachments/nested/a(b).bin",
        "attachments/nested/a b.png",
        "attachments/third.pdf",
    ] {
        put_bytes(&f.root, path, path.as_bytes());
    }
    let body = "# Unlinked ordinary heading\n\n[One](attachments/nested/a(b).bin#part)\n![Two](attachments/nested/a%20b.png?download=1#image)\n[Three](<attachments/third.pdf> \"caption\")\n[Self](#heading)\n[Remote](https://example.test/never-fetch)\n\n~~~~md\n![inert](missing.png)\n~~~\n[still inert][missing]\n~~~~\nOrdinary text without links.\n";
    f.run(|| {
        replace(&f, &f.version(), body.as_bytes()).unwrap();
    });
    let bundle = output.join("bundle");
    f.run(|| backup::backup_workspace(&f.root, &bundle))
        .unwrap();
    restore::restore_workspace(&bundle, &output.join("restored"), &output.join("metadata"))
        .unwrap();
    assert_eq!(
        fs::read(output.join("restored/page.md")).unwrap(),
        body.as_bytes()
    );
    for path in [
        "attachments/nested/a(b).bin",
        "attachments/nested/a b.png",
        "attachments/third.pdf",
    ] {
        assert_eq!(
            fs::read(output.join("restored").join(path)).unwrap(),
            path.as_bytes()
        );
    }
    fs::remove_file(bundle.join("bodies/attachments/nested/a b.png")).unwrap();
    assert_refusal(
        backup::validate_backup(&bundle).unwrap_err(),
        BackupErrorKind::RequiredPartMissing,
    );
    fs::remove_dir_all(output).unwrap();
}

#[test]
fn portable_unsupported_dependency_forms_are_named_and_never_published_complete() {
    for (name, body) in [
        (
            "inline",
            "See [Original](attachments/data.bin) in this sentence.\n",
        ),
        (
            "invalid-backtick-info",
            "```info` ![x](attachments/missing.png)\n",
        ),
        (
            "image-inline",
            "Text ![Original](attachments/data.bin) text.\n",
        ),
        (
            "reference",
            "[Original][asset]\n\n[asset]: attachments/data.bin\n",
        ),
        (
            "collapsed-reference",
            "![asset][]\n\n[asset]: attachments/data.bin\n",
        ),
        (
            "shortcut-reference",
            "[asset]\n\n[asset]: attachments/data.bin\n",
        ),
        (
            "multiline-reference-label",
            "[asset\nlabel]: attachments/missing.bin\n\n[asset label]\n",
        ),
        ("html", "<img src=\"attachments/data.bin\">\n"),
        (
            "multiline-html",
            "<a\nhref=\"attachments/data.bin\">Original</a>\n",
        ),
        (
            "input-html",
            "<input\ntype=\"image\"\nsrc=\"attachments/data.bin\">\n",
        ),
        ("svg-image-html", "<image\nhref=\"attachments/data.bin\">\n"),
    ] {
        let f = fixture(&format!("portable-unsupported-{name}"));
        let output = testutil::temp_vault(&format!("portable-unsupported-output-{name}"));
        put_bytes(&f.root, ATTACHMENT, b"retained");
        f.run(|| {
            replace(&f, &f.version(), body.as_bytes()).unwrap();
        });
        let before = fs::read(&f.db).unwrap();
        let error = f
            .run(|| backup::backup_workspace(&f.root, &output.join("bundle")))
            .unwrap_err();
        assert_refusal(error, BackupErrorKind::UnsupportedDependency);
        assert_eq!(fs::read(&f.db).unwrap(), before);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), body.as_bytes());
        assert!(!output.join("bundle/manifest.json").exists());
        fs::remove_dir_all(output).unwrap();
    }
}

#[test]
fn portable_source_drift_after_capture_or_copy_never_publishes_complete() {
    for point in ["export_captured", "export_copied"] {
        let p = PortableFixture::new(point);
        let before = fs::read(&p.selected.db).unwrap();
        let error = p
            .selected
            .run(|| {
                backup::with_step_for_test(
                    point,
                    |source, _| {
                        fs::write(source.join(ATTACHMENT), b"outside changed this attachment")
                            .unwrap()
                    },
                    || backup::backup_workspace(&p.selected.root, &p.bundle()),
                )
            })
            .unwrap_err();
        assert_refusal(error, BackupErrorKind::SourceChanged);
        assert!(!p.bundle().join("manifest.json").exists());
        assert_eq!(fs::read(&p.selected.db).unwrap(), before);
        assert_eq!(
            fs::read(p.selected.root.join(ATTACHMENT)).unwrap(),
            b"outside changed this attachment"
        );
    }
}

#[test]
fn portable_create_new_publication_failure_never_overwrites_foreign_manifest() {
    let p = PortableFixture::new("publish-existing");
    let root_before = file_tree(&p.selected.root);
    let origin_before = file_tree(&p.selected.origin);
    let error = p
        .selected
        .run(|| {
            backup::with_step_for_test(
                "export_publish",
                |_, bundle| {
                    fs::write(
                        bundle.join("manifest.json"),
                        b"foreign manifest must survive",
                    )
                    .unwrap()
                },
                || backup::backup_workspace(&p.selected.root, &p.bundle()),
            )
        })
        .unwrap_err();
    assert_refusal(error, BackupErrorKind::DestinationUnavailable);
    assert_eq!(
        fs::read(p.bundle().join("manifest.json")).unwrap(),
        b"foreign manifest must survive"
    );
    assert!(backup::validate_backup(&p.bundle()).is_err());
    assert_eq!(file_tree(&p.selected.root), root_before);
    assert_eq!(file_tree(&p.selected.origin), origin_before);
}

#[test]
fn portable_restore_copy_drift_and_extra_membership_leave_preparing_marker() {
    for (label, extra) in [("changed", false), ("undeclared", true)] {
        let p = PortableFixture::new(label);
        let bundle = p.export();
        let bundle_before = file_tree(&bundle);
        let bodies = p.output.join("restored");
        let metadata = p.output.join("metadata");
        let error = backup::with_step_for_test(
            "restore_copied",
            move |body_root, _| {
                let path = if extra { "undeclared.bin" } else { "page.md" };
                fs::write(body_root.join(path), b"foreign destination bytes").unwrap();
            },
            || restore::restore_workspace(&bundle, &bodies, &metadata),
        )
        .unwrap_err();
        assert_refusal(
            error,
            if extra {
                BackupErrorKind::SourceChanged
            } else {
                BackupErrorKind::PartMismatch
            },
        );
        assert_no_ready(&bodies);
        assert_eq!(file_tree(&bundle), bundle_before);
        assert!(!metadata.join("selected.lock").exists());
    }
}

#[test]
fn portable_restore_rechecks_input_and_owned_marker_before_publication() {
    for input_drift in [false, true] {
        let p = PortableFixture::new(if input_drift {
            "input-drift"
        } else {
            "marker-replaced"
        });
        let bundle = p.export();
        let captured_bundle = bundle.clone();
        let bodies = p.output.join("restored");
        let metadata = p.output.join("metadata");
        let point = if input_drift {
            "restore_copied"
        } else {
            "restore_publish"
        };
        let error = backup::with_step_for_test(
            point,
            move |body_root, _| {
                if input_drift {
                    fs::write(
                        captured_bundle.join("bodies").join(ATTACHMENT),
                        b"changed input",
                    )
                    .unwrap();
                } else {
                    let marker = body_root.join(".cerebro/workspace-format.json");
                    let previous = body_root.parent().unwrap().join("removed-owned-marker");
                    fs::rename(&marker, previous).unwrap();
                    fs::write(marker, br#"{"state":"foreign"}"#).unwrap();
                }
            },
            || restore::restore_workspace(&bundle, &bodies, &metadata),
        )
        .unwrap_err();
        assert_refusal(
            error,
            if input_drift {
                BackupErrorKind::PartMismatch
            } else {
                BackupErrorKind::SourceChanged
            },
        );
        assert_no_ready(&bodies);
        if !input_drift {
            assert_eq!(
                fs::read(bodies.join(".cerebro/workspace-format.json")).unwrap(),
                br#"{"state":"foreign"}"#
            );
        }
    }
}

#[test]
fn portable_implicit_directory_prefix_aliases_are_refused_before_copy() {
    let p = PortableFixture::new("implicit-prefix-alias");
    let bundle = p.export();
    let mut manifest = read_manifest(&bundle);
    let template = part_mut(&mut manifest, "bodies", "page.md").clone();
    for name in ["fresh-prefix/one.bin", "FRESH-PREFIX/two.bin"] {
        let mut part = template.clone();
        part["path"] = json!(name);
        manifest["parts"].as_array_mut().unwrap().push(part);
    }
    write_manifest(&bundle, &manifest);
    assert_restore_refused(
        &bundle,
        &p.output.join("prefix"),
        BackupErrorKind::InvalidPath,
    );
}

#[test]
fn portable_missing_existing_locks_are_never_created_by_backup() {
    for selected_lock in [true, false] {
        let p = PortableFixture::new(if selected_lock {
            "missing-selected-lock"
        } else {
            "missing-ledger-lock"
        });
        let lock = if selected_lock {
            p.selected.db.parent().unwrap().join("selected.lock")
        } else {
            ledger::ledger_dir(&p.selected.root).join("lock")
        };
        fs::remove_file(&lock).unwrap();
        let before = file_tree(&p.selected.origin);
        assert!(p
            .selected
            .run(|| backup::backup_workspace(&p.selected.root, &p.bundle()))
            .is_err());
        assert!(!lock.exists());
        assert!(!p.bundle().exists());
        assert_eq!(file_tree(&p.selected.origin), before);
    }
}

#[test]
fn portable_retained_category_and_aggregate_limits_are_checked_before_payload_reads() {
    let p = PortableFixture::new("retained-budget");
    let bundle = p.export();
    let clean = read_manifest(&bundle);
    let mut one = clean.clone();
    part_mut(&mut one, "bodies", ATTACHMENT)["bytes"] =
        json!((limit("retained_bytes") + 1).to_string());
    write_manifest(&bundle, &one);
    assert_restore_refused(
        &bundle,
        &p.output.join("retained-part"),
        BackupErrorKind::SourceLimit,
    );
    let mut aggregate = clean;
    let template = part_mut(&mut aggregate, "bodies", ATTACHMENT).clone();
    for index in 0..3 {
        let mut part = template.clone();
        part["path"] = json!(format!("attachments/declared-{index}.bin"));
        part["bytes"] = json!(limit("retained_bytes").to_string());
        aggregate["parts"].as_array_mut().unwrap().push(part);
    }
    write_manifest(&bundle, &aggregate);
    assert_restore_refused(
        &bundle,
        &p.output.join("retained-aggregate"),
        BackupErrorKind::SourceLimit,
    );
}

#[test]
fn portable_oversized_historical_secret_is_excluded_before_size_or_content() {
    let p = PortableFixture::new("oversized-original-secret");
    let path = p
        .selected
        .db
        .parent()
        .unwrap()
        .join("originals")
        .join(CONFIG_TEMP);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(limit("retained_bytes") + 1)
        .unwrap();
    let bundle = p.export();
    let manifest = read_manifest(&bundle);
    let omitted = manifest["exclusions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["namespace"] == "originals" && row["path"] == CONFIG_TEMP)
        .unwrap();
    assert_eq!(omitted["reason"], "private_credentials");
    assert!(omitted.get("bytes").is_none());
    assert!(omitted.get("hash").is_none());
    assert!(!bundle.join("metadata/originals").join(CONFIG_TEMP).exists());
    assert_eq!(
        fs::metadata(path).unwrap().len(),
        limit("retained_bytes") + 1
    );
}

#[test]
fn portable_last_export_publication_window_rechecks_payload_and_source() {
    for source_drift in [false, true] {
        let p = PortableFixture::new(if source_drift {
            "last-source-drift"
        } else {
            "last-output-drift"
        });
        let before = fs::read(&p.selected.db).unwrap();
        let error = p
            .selected
            .run(|| {
                backup::with_step_for_test(
                    "export_publish",
                    move |source, bundle| {
                        let path = if source_drift {
                            source.join(ATTACHMENT)
                        } else {
                            bundle.join("bodies").join(ATTACHMENT)
                        };
                        fs::write(path, b"last-window changed bytes").unwrap();
                    },
                    || backup::backup_workspace(&p.selected.root, &p.bundle()),
                )
            })
            .unwrap_err();
        assert_refusal(
            error,
            if source_drift {
                BackupErrorKind::SourceChanged
            } else {
                BackupErrorKind::PartMismatch
            },
        );
        assert!(!p.bundle().join("manifest.json").exists());
        assert_eq!(fs::read(&p.selected.db).unwrap(), before);
    }
}

#[test]
fn portable_last_restore_publication_window_rechecks_installed_and_input_bytes() {
    for input_drift in [false, true] {
        let p = PortableFixture::new(if input_drift {
            "last-input-drift"
        } else {
            "last-installed-drift"
        });
        let bundle = p.export();
        let captured_bundle = bundle.clone();
        let bodies = p.output.join("restored");
        let metadata = p.output.join("metadata");
        let error = backup::with_step_for_test(
            "restore_publish",
            move |root, _| {
                let path = if input_drift {
                    captured_bundle.join("bodies").join(ATTACHMENT)
                } else {
                    root.join("page.md")
                };
                fs::write(path, b"last-window changed bytes").unwrap();
            },
            || restore::restore_workspace(&bundle, &bodies, &metadata),
        )
        .unwrap_err();
        assert_refusal(error, BackupErrorKind::PartMismatch);
        assert_no_ready(&bodies);
        assert!(!metadata.join("selected.lock").exists());
    }
}

#[test]
fn portable_sqlite_snapshot_never_writes_a_replaced_reservation_or_foreign_hardlink() {
    for (after_open, hardlink) in [(false, false), (false, true), (true, false), (true, true)] {
        let p = PortableFixture::new(&format!("snapshot-swap-{after_open}-{hardlink}"));
        let foreign = p.output.join("foreign-database-sentinel");
        fs::write(
            &foreign,
            b"foreign bytes must never be a SQLite backup destination",
        )
        .unwrap();
        let sentinel = foreign.clone();
        let saved = p.output.join("owned-reservation");
        let source_before = file_tree(&p.selected.root);
        let origin_before = file_tree(&p.selected.origin);
        let error = p
            .selected
            .run(|| {
                selected::backup::with_snapshot_open_for_test(
                    after_open,
                    move |destination| {
                        fs::rename(destination, &saved).unwrap();
                        if hardlink {
                            fs::hard_link(&sentinel, destination).unwrap();
                        } else {
                            fs::write(destination, b"foreign replacement bytes").unwrap();
                        }
                    },
                    || backup::backup_workspace(&p.selected.root, &p.bundle()),
                )
            })
            .unwrap_err();
        assert_refusal(error, BackupErrorKind::SourceChanged);
        assert_eq!(
            fs::read(foreign).unwrap(),
            b"foreign bytes must never be a SQLite backup destination"
        );
        let expected = if hardlink {
            b"foreign bytes must never be a SQLite backup destination".as_slice()
        } else {
            b"foreign replacement bytes".as_slice()
        };
        assert_eq!(
            fs::read(p.bundle().join("metadata/workspace.db")).unwrap(),
            expected
        );
        assert!(!p.bundle().join("manifest.json").exists());
        assert_eq!(file_tree(&p.selected.root), source_before);
        assert_eq!(file_tree(&p.selected.origin), origin_before);
    }
}

#[test]
fn portable_manifest_cannot_hide_an_unpaired_ordinary_body_as_retained() {
    let p = PortableFixture::new("forged-retained-body");
    let bundle = p.export();
    let mut manifest = read_manifest(&bundle);
    let bytes = b"[Unaccounted](attachments/missing.bin)\n";
    put_bytes(&bundle, "bodies/rogue.md", bytes);
    manifest["parts"].as_array_mut().unwrap().push(json!({
        "namespace":"bodies", "path":"rogue.md", "category":"retained",
        "bytes":bytes.len().to_string(), "hash":ledger::sha256_hex(bytes)
    }));
    write_manifest(&bundle, &manifest);
    assert_refusal(
        backup::validate_backup(&bundle).unwrap_err(),
        BackupErrorKind::RequiredPartMissing,
    );
    assert_restore_refused(
        &bundle,
        &p.output.join("rogue"),
        BackupErrorKind::RequiredPartMissing,
    );
}

#[test]
fn portable_non_ascii_ledger_segment_names_refuse_without_panicking() {
    let p = PortableFixture::new("unicode-ledger-name");
    let bundle = p.export();
    let mut manifest = read_manifest(&bundle);
    let path = format!(
        "{}/é{}{}",
        ledger::LEDGER_DIR,
        "a".repeat(16),
        ledger::segment::OPEN_SUFFIX
    );
    let bytes = b"hostile parser name";
    put_bytes(&bundle, &format!("bodies/{path}"), bytes);
    manifest["parts"].as_array_mut().unwrap().push(json!({
        "namespace":"bodies", "path":path, "category":"retained",
        "bytes":bytes.len().to_string(), "hash":ledger::sha256_hex(bytes)
    }));
    write_manifest(&bundle, &manifest);
    assert_refusal(
        backup::validate_backup(&bundle).unwrap_err(),
        BackupErrorKind::InvalidLedger,
    );
    assert_restore_refused(
        &bundle,
        &p.output.join("unicode-ledger"),
        BackupErrorKind::InvalidLedger,
    );
}

#[test]
fn portable_late_fifo_marker_substitution_refuses_without_waiting_or_writing() {
    use std::os::unix::fs::FileTypeExt;
    let p = PortableFixture::new("fifo-marker");
    let bundle = p.export();
    let bodies = p.output.join("restored");
    let metadata = p.output.join("metadata");
    let changed_at = std::rc::Rc::new(std::cell::Cell::new(None::<Instant>));
    let capture = changed_at.clone();
    let error = backup::with_step_for_test(
        "restore_publish",
        move |root, _| {
            capture.set(Some(Instant::now()));
            let marker = root.join(".cerebro/workspace-format.json");
            fs::remove_file(&marker).unwrap();
            let path = std::ffi::CString::new(marker.to_str().unwrap()).unwrap();
            // Disposable fault fixture only; no writer is opened on the FIFO.
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        },
        || restore::restore_workspace(&bundle, &bodies, &metadata),
    )
    .unwrap_err();
    assert_refusal(error, BackupErrorKind::InvalidPath);
    assert!(changed_at.get().unwrap().elapsed() < Duration::from_secs(2));
    assert!(
        fs::symlink_metadata(bodies.join(".cerebro/workspace-format.json"))
            .unwrap()
            .file_type()
            .is_fifo()
    );
    assert!(!metadata.join("selected.lock").exists());
}

#[test]
fn portable_restore_refuses_changed_provenance_before_inactive_publication() {
    let p = PortableFixture::new("provenance-drift");
    let bundle = p.export();
    let bundle_before = file_tree(&bundle);
    let bodies = p.output.join("restored");
    let metadata = p.output.join("metadata");
    let error = backup::with_step_for_test(
        "restore_publish",
        |root, _| {
            fs::write(
                root.join(".cerebro/restored-manifest.json"),
                b"foreign provenance must survive",
            )
            .unwrap();
        },
        || restore::restore_workspace(&bundle, &bodies, &metadata),
    )
    .unwrap_err();
    assert_refusal(error, BackupErrorKind::PartMismatch);
    assert_no_ready(&bodies);
    assert_eq!(
        fs::read(bodies.join(".cerebro/restored-manifest.json")).unwrap(),
        b"foreign provenance must survive"
    );
    assert_eq!(file_tree(&bundle), bundle_before);
    assert!(!metadata.join("selected.lock").exists());
}

#[test]
fn portable_offline_workspace_identity_must_use_the_existing_uuid_grammar() {
    let p = PortableFixture::new("invalid-workspace-id");
    let bundle = p.export();
    let database = bundle.join("metadata/workspace.db");
    let conn = Connection::open(&database).unwrap();
    conn.execute(
        "UPDATE workspace SET workspace_id=?1",
        ["not-a-workspace-uuid"],
    )
    .unwrap();
    drop(conn);
    let mut manifest = read_manifest(&bundle);
    manifest["workspace_id"] = json!("not-a-workspace-uuid");
    let bytes = fs::read(database).unwrap();
    let part = part_mut(&mut manifest, "metadata", "workspace.db");
    part["bytes"] = json!(bytes.len().to_string());
    part["hash"] = json!(ledger::sha256_hex(&bytes));
    write_manifest(&bundle, &manifest);
    assert_refusal(
        backup::validate_backup(&bundle).unwrap_err(),
        BackupErrorKind::InvalidMetadata,
    );
    assert_restore_refused(
        &bundle,
        &p.output.join("invalid-identity"),
        BackupErrorKind::InvalidMetadata,
    );
}

#[test]
fn portable_canonical_receipts_reject_forged_shapes_even_with_matching_outer_hashes() {
    let cases: &[(&str, SqlValue)] = &[
        ("run_id", SqlValue::Text("foreign-run".into())),
        ("approved_by", SqlValue::Text("foreign-approver".into())),
        ("actor", SqlValue::Text("agent:foreign".into())),
        ("at", SqlValue::Text("not-rfc3339".into())),
        ("at", SqlValue::Blob(vec![1, 2, 3])),
        ("previous_revision", SqlValue::Integer(1)),
        ("revision", SqlValue::Integer(999)),
        ("epoch", SqlValue::Integer(0)),
        ("epoch", SqlValue::Integer(999)),
        (
            "record_id",
            SqlValue::Text("11111111-1111-4111-8111-111111111111".into()),
        ),
        ("record_id", SqlValue::Text("not-a-uuid".into())),
        ("metadata_before_hash", SqlValue::Text("invalid".into())),
        ("metadata_after_hash", SqlValue::Text("invalid".into())),
        ("body_before_hash", SqlValue::Text("invalid".into())),
        ("body_after_hash", SqlValue::Text("invalid".into())),
    ];
    for operation in ["page.body", "page.full_width"] {
        for (index, (column, value)) in cases.iter().enumerate() {
            let p = PortableFixture::new(&format!("forged-receipt-{operation}-{index}"));
            let bundle = p.export();
            let database = bundle.join("metadata/workspace.db");
            let conn = Connection::open(&database).unwrap();
            // The bundled SQLite enables foreign keys by default. This fixture
            // deliberately forges missing/invalid record references so the
            // portable decoder, not SQLite's UPDATE guard, must reject them.
            conn.pragma_update(None, "foreign_keys", false).unwrap();
            assert_eq!(
                conn.execute(
                    &format!("UPDATE metadata_receipts SET {column}=?1 WHERE operation=?2"),
                    rusqlite::params![value, operation]
                )
                .unwrap(),
                1
            );
            drop(conn);
            let mut manifest = read_manifest(&bundle);
            let bytes = fs::read(database).unwrap();
            let part = part_mut(&mut manifest, "metadata", "workspace.db");
            part["bytes"] = json!(bytes.len().to_string());
            part["hash"] = json!(ledger::sha256_hex(&bytes));
            write_manifest(&bundle, &manifest);
            assert_refusal(
                backup::validate_backup(&bundle).unwrap_err(),
                BackupErrorKind::InvalidMetadata,
            );
            assert_restore_refused(
                &bundle,
                &p.output.join("forged"),
                BackupErrorKind::InvalidMetadata,
            );
        }
        let p = PortableFixture::new(&format!("wrong-operation-{operation}"));
        let bundle = p.export();
        let database = bundle.join("metadata/workspace.db");
        let conn = Connection::open(&database).unwrap();
        let replacement = if operation == "page.body" {
            "page.full_width"
        } else {
            "page.body"
        };
        assert_eq!(
            conn.execute(
                "UPDATE metadata_receipts SET operation=?1 WHERE operation=?2",
                rusqlite::params![replacement, operation]
            )
            .unwrap(),
            1
        );
        drop(conn);
        let mut manifest = read_manifest(&bundle);
        let bytes = fs::read(database).unwrap();
        let part = part_mut(&mut manifest, "metadata", "workspace.db");
        part["bytes"] = json!(bytes.len().to_string());
        part["hash"] = json!(ledger::sha256_hex(&bytes));
        write_manifest(&bundle, &manifest);
        assert_refusal(
            backup::validate_backup(&bundle).unwrap_err(),
            BackupErrorKind::InvalidMetadata,
        );
        assert_restore_refused(
            &bundle,
            &p.output.join("wrong-operation"),
            BackupErrorKind::InvalidMetadata,
        );
    }
}

#[test]
fn portable_source_malformed_receipts_refuse_without_changing_any_source_bytes() {
    for operation in ["page.body", "page.full_width"] {
        let p = PortableFixture::new(&format!("source-receipt-{operation}"));
        p.selected
            .conn()
            .execute(
                "UPDATE metadata_receipts SET run_id='foreign-run' WHERE operation=?1",
                [operation],
            )
            .unwrap();
        let before_root = file_tree(&p.selected.root);
        let before_origin = file_tree(&p.selected.origin);
        assert_refusal(
            p.selected
                .run(|| backup::backup_workspace(&p.selected.root, &p.bundle()))
                .unwrap_err(),
            BackupErrorKind::InvalidMetadata,
        );
        assert!(!p.bundle().exists());
        assert_eq!(file_tree(&p.selected.root), before_root);
        assert_eq!(file_tree(&p.selected.origin), before_origin);
    }
}

#[test]
fn portable_offline_database_fifo_substitution_after_capture_never_reopens_the_path() {
    use std::os::unix::fs::FileTypeExt;
    for restoring in [false, true] {
        let p = PortableFixture::new(if restoring {
            "restore-db-fifo"
        } else {
            "validate-db-fifo"
        });
        let bundle = p.export();
        let database_bytes = fs::read(bundle.join("metadata/workspace.db")).unwrap();
        let saved = p.output.join("held-original-database");
        let captured_saved = saved.clone();
        let bodies = p.output.join("restored");
        let metadata = p.output.join("metadata");
        let point = if restoring {
            "restore_database_captured"
        } else {
            "validate_database_captured"
        };
        let started = std::rc::Rc::new(std::cell::Cell::new(None::<Instant>));
        let captured_started = started.clone();
        let error = backup::with_step_for_test(
            point,
            move |_, database| {
                captured_started.set(Some(Instant::now()));
                fs::rename(database, &captured_saved).unwrap();
                let path = std::ffi::CString::new(database.to_str().unwrap()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            },
            || {
                if restoring {
                    restore::restore_workspace(&bundle, &bodies, &metadata).map(|_| ())
                } else {
                    backup::validate_backup(&bundle).map(|_| ())
                }
            },
        )
        .unwrap_err();
        assert_refusal(error, BackupErrorKind::InvalidPath);
        assert!(started.get().unwrap().elapsed() < Duration::from_secs(2));
        assert_eq!(fs::read(saved).unwrap(), database_bytes);
        let fifo = if restoring {
            metadata.join("workspace.db")
        } else {
            bundle.join("metadata/workspace.db")
        };
        assert!(fs::symlink_metadata(fifo).unwrap().file_type().is_fifo());
        if restoring {
            assert_no_ready(&bodies);
        } else {
            assert!(!bodies.exists());
        }
    }
}

#[test]
fn portable_offline_wal_header_is_refused_without_a_sidecar_or_recovery() {
    let p = PortableFixture::new("offline-wal-header");
    let bundle = p.export();
    let database = bundle.join("metadata/workspace.db");
    let mut bytes = fs::read(&database).unwrap();
    bytes[18] = 2;
    bytes[19] = 2;
    fs::write(&database, &bytes).unwrap();
    let mut manifest = read_manifest(&bundle);
    let part = part_mut(&mut manifest, "metadata", "workspace.db");
    part["hash"] = json!(ledger::sha256_hex(&bytes));
    write_manifest(&bundle, &manifest);
    let before = file_tree(&bundle);
    assert_refusal(
        backup::validate_backup(&bundle).unwrap_err(),
        BackupErrorKind::InvalidMetadata,
    );
    assert_restore_refused(
        &bundle,
        &p.output.join("wal"),
        BackupErrorKind::InvalidMetadata,
    );
    assert_eq!(file_tree(&bundle), before);
}

#[test]
fn portable_live_source_fifo_substitution_cannot_block_the_sqlite_open() {
    use std::os::unix::fs::FileTypeExt;
    let p = PortableFixture::new("live-db-fifo");
    let before = fs::read(&p.selected.db).unwrap();
    let before_root = file_tree(&p.selected.root);
    let saved = p.output.join("pinned-original-database");
    let captured_saved = saved.clone();
    let started = std::rc::Rc::new(std::cell::Cell::new(None::<Instant>));
    let captured_started = started.clone();
    let error = p
        .selected
        .run(|| {
            selected::backup::with_source_open_for_test(
                move |database| {
                    captured_started.set(Some(Instant::now()));
                    fs::rename(database, &captured_saved).unwrap();
                    let path = std::ffi::CString::new(database.to_str().unwrap()).unwrap();
                    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
                },
                || backup::backup_workspace(&p.selected.root, &p.bundle()),
            )
        })
        .unwrap_err();
    assert_refusal(error, BackupErrorKind::SourceChanged);
    assert!(started.get().unwrap().elapsed() < Duration::from_secs(2));
    assert_eq!(fs::read(saved).unwrap(), before);
    assert_eq!(file_tree(&p.selected.root), before_root);
    assert!(fs::symlink_metadata(&p.selected.db)
        .unwrap()
        .file_type()
        .is_fifo());
    assert!(!p.bundle().exists());
}

#[test]
fn portable_live_source_sidecars_are_never_hidden_by_the_descriptor_alias() {
    for suffix in ["-journal", "-wal", "-shm"] {
        let p = PortableFixture::new(&format!("live-sidecar{suffix}"));
        let mut sidecar = p.selected.db.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        let capture = sidecar.clone();
        let database = fs::read(&p.selected.db).unwrap();
        let error = p
            .selected
            .run(|| {
                selected::backup::with_source_open_for_test(
                    move |_| {
                        fs::write(&capture, b"foreign sidecar must not be opened or recovered")
                            .unwrap();
                    },
                    || backup::backup_workspace(&p.selected.root, &p.bundle()),
                )
            })
            .unwrap_err();
        assert_refusal(error, BackupErrorKind::RecoveryRequired);
        assert_eq!(
            fs::read(sidecar).unwrap(),
            b"foreign sidecar must not be opened or recovered"
        );
        assert_eq!(fs::read(&p.selected.db).unwrap(), database);
        assert!(!p.bundle().exists());
    }
}

#[test]
fn portable_live_descriptor_snapshot_keeps_real_sqlite_read_locks_and_default_vfs() {
    let p = PortableFixture::new("live-posix-read-lock");
    // macOS temp paths may begin at the /var symlink. Match the production
    // canonical source path so NOFOLLOW reaches the real lock contention.
    let database = fs::canonicalize(&p.selected.db).unwrap();
    let original = fs::read(&database).unwrap();
    let default_before = unsafe { rusqlite::ffi::sqlite3_vfs_find(std::ptr::null()) } as usize;
    p.selected.run(|| backup::with_step_for_test("export_captured", move |source, _| {
        assert_eq!(selected::read_body(source, "page.md").unwrap_err().kind, AuthorityErrorKind::Busy);
        assert_eq!(unsafe { rusqlite::ffi::sqlite3_vfs_find(std::ptr::null()) } as usize, default_before);
        // Each ordinary connection tries a real SQLite exclusive lock against
        // the same inode. Dropping the first failed contender must not release
        // the descriptor source's held shared lock before the second tries.
        for _ in 0..2 {
            let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW;
            let contender = Connection::open_with_flags_and_vfs(&database, flags, "unix-posix").unwrap();
            contender.busy_timeout(Duration::ZERO).unwrap();
            let error = contender.execute_batch("BEGIN EXCLUSIVE").unwrap_err();
            assert!(matches!(error, rusqlite::Error::SqliteFailure(code, _)
                if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)));
        }
    }, || backup::backup_workspace(&p.selected.root, &p.bundle()))).unwrap();
    assert_eq!(
        unsafe { rusqlite::ffi::sqlite3_vfs_find(std::ptr::null()) } as usize,
        default_before
    );
    assert_eq!(fs::read(&p.selected.db).unwrap(), original);
    backup::validate_backup(&p.bundle()).unwrap();
    p.selected.run(|| {
        assert_eq!(
            selected::read_body(&p.selected.root, "page.md").unwrap(),
            BODY_WITH_ATTACHMENT
        )
    });
}

#[test]
fn portable_live_source_refuses_wal_header_without_opening_sidecars_or_recovery() {
    let p = PortableFixture::new("live-wal-header");
    let mut bytes = fs::read(&p.selected.db).unwrap();
    bytes[18] = 2;
    bytes[19] = 2;
    fs::write(&p.selected.db, &bytes).unwrap();
    let before = file_tree(&p.selected.origin);
    assert_refusal(
        p.selected
            .run(|| backup::backup_workspace(&p.selected.root, &p.bundle()))
            .unwrap_err(),
        BackupErrorKind::InvalidMetadata,
    );
    assert_eq!(file_tree(&p.selected.origin), before);
    assert!(!p.bundle().exists());
}

#[test]
fn portable_restore_final_database_capture_must_match_the_manifest_with_unchanged_counters() {
    let p = PortableFixture::new("restore-final-database-replacement");
    let bundle = p.export();
    let bundle_before = file_tree(&bundle);
    let original = fs::read(bundle.join("metadata/workspace.db")).unwrap();
    let replacement_path = p.output.join("replacement.db");
    fs::write(&replacement_path, &original).unwrap();
    let conn = Connection::open(&replacement_path).unwrap();
    let stored: String = conn
        .query_row(
            "SELECT metadata FROM records WHERE id=?1",
            [RECORD],
            |row| row.get(0),
        )
        .unwrap();
    let mut changed: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(
        changed["value"]["unknown_key"]["value"]["verbatim"]["value"],
        "007"
    );
    changed["value"]["unknown_key"]["value"]["verbatim"]["value"] = json!("008");
    assert_eq!(
        conn.execute(
            "UPDATE records SET metadata=?1 WHERE id=?2",
            rusqlite::params![changed.to_string(), RECORD]
        )
        .unwrap(),
        1
    );
    drop(conn);
    let replacement = fs::read(&replacement_path).unwrap();
    assert_eq!(
        replacement.len(),
        original.len(),
        "the hash check must catch this same-length replacement"
    );
    assert_ne!(replacement, original);
    let cap = selected::backup::source_limits().5;
    let original_facts = selected::backup::read_offline(&original, WORKSPACE, cap).unwrap();
    let replacement_facts = selected::backup::read_offline(&replacement, WORKSPACE, cap).unwrap();
    assert_eq!(replacement_facts.workspace_id, original_facts.workspace_id);
    assert_eq!(replacement_facts.epoch, original_facts.epoch);
    assert_eq!(
        replacement_facts.schema_revision,
        original_facts.schema_revision
    );
    assert_eq!(
        replacement_facts.schema_version,
        original_facts.schema_version
    );
    assert_ne!(replacement_facts.records, original_facts.records);
    let bodies = p.output.join("restored");
    let metadata = p.output.join("metadata");
    // Replace only after the installed-parts hashes and coverage have passed.
    let error = backup::with_step_for_test(
        "restore_database_capture",
        move |_, database| {
            assert_eq!(fs::read(database).unwrap(), original);
            fs::rename(&replacement_path, database).unwrap();
        },
        || restore::restore_workspace(&bundle, &bodies, &metadata),
    )
    .unwrap_err();
    assert_refusal(error, BackupErrorKind::PartMismatch);
    assert_no_ready(&bodies);
    assert_eq!(
        fs::read(metadata.join("workspace.db")).unwrap(),
        replacement
    );
    assert_eq!(file_tree(&bundle), bundle_before);
    assert!(!metadata.join("selected.lock").exists());
}

// M99.8 P1: separate test-only module; existing portable scenario bodies are unchanged.
#[path = "nested_format_boundary_tests.rs"]
mod nested_format_boundary;


#[test]
fn admitted_native_export_keeps_original_source_while_unrelated_open_publishes() {
    let f = PortableFixture::new("admitted-original-source");
    let other = f.output.join("other");
    fs::create_dir(&other).unwrap();
    let other = fs::canonicalize(&other).unwrap();
    let bundle = f.output.join("native-bundle");
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let opening = context.request_open(&f.selected.root).unwrap();
        crate::run_open_attempt(&context, &opening, || {
            context.publish_attempt_with(&opening, || Ok(())).map_err(|e| e.message)
        }, || Ok(())).unwrap();
        let ticket = context.capture_selected_backup_opening(&f.selected.root).unwrap();
        let choice = backup::NewDirectoryChoice::new(&f.output, "native-bundle").unwrap();
        let (lease, source) = context.reserve_selected_output(ticket, choice, || Ok(())).unwrap();
        let concurrent = context.clone();
        let other_for_hook = other.clone();
        let enclosing = f.output.clone();
        backup::with_step_for_test("export_publish", move |_, _| {
            // This thread owns no source/SQLite/ledger resource; never enter
            // ActiveRoot on the copier thread while its source locks are held.
            std::thread::spawn(move || {
                assert!(concurrent.request_open(&enclosing).is_err());
                let next = concurrent.request_open(&other_for_hook).unwrap();
                crate::run_open_attempt(&concurrent, &next, || {
                    concurrent.publish_attempt_with(&next, || Ok(())).map_err(|e| e.message)
                }, || Ok(())).unwrap();
            }).join().unwrap();
        }, || backup::backup_admitted(source, lease)).unwrap();
        assert_eq!(context.active_root().unwrap(), Some(other.clone()));
        assert_eq!(fs::read(bundle.join("bodies/page.md")).unwrap(), fs::read(f.selected.root.join("page.md")).unwrap());
        backup::validate_backup(&bundle).unwrap();
        // All copy readers/writers have returned before the outer lease drops.
        let fresh = backup::NewDirectoryChoice::new(&f.output, "after-copy").unwrap();
        drop(context.reserve_output(fresh, &[], || Ok(())).unwrap());
    });
}

#[test]
fn admitted_native_export_refuses_replaced_database_before_any_output() {
    let f = PortableFixture::new("admitted-database-replacement");
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let opening = context.request_open(&f.selected.root).unwrap();
        crate::run_open_attempt(&context, &opening, || {
            context.publish_attempt_with(&opening, || Ok(())).map_err(|e| e.message)
        }, || Ok(())).unwrap();
        let ticket = context.capture_selected_backup_opening(&f.selected.root).unwrap();
        let choice = backup::NewDirectoryChoice::new(&f.output, "native-bundle").unwrap();
        let (lease, source) = context.reserve_selected_output(ticket, choice, || Ok(())).unwrap();
        let old = f.selected.db.with_extension("original");
        fs::rename(&f.selected.db, &old).unwrap();
        fs::copy(&old, &f.selected.db).unwrap();
        private_file(&f.selected.db);
        let error = backup::backup_admitted(source, lease).unwrap_err();
        assert_eq!(error.kind, BackupErrorKind::SourceChanged);
        assert!(!f.output.join("native-bundle").exists());
        // A failing reader also settles before reservation release.
        let fresh = backup::NewDirectoryChoice::new(&f.output, "after-refusal").unwrap();
        drop(context.reserve_output(fresh, &[], || Ok(())).unwrap());
    });
}

// M99 native checked-input/admitted-restore boundary. Existing path tests stay intact.
fn copy_valid_portable_tree(from: &Path, to: &Path) {
    fs::create_dir(to).unwrap();
    for entry in walkdir::WalkDir::new(from).min_depth(1) {
        let entry = entry.unwrap();
        let target = to.join(entry.path().strip_prefix(from).unwrap());
        if entry.file_type().is_dir() { fs::create_dir(&target).unwrap(); }
        else { assert!(entry.file_type().is_file()); fs::copy(entry.path(), target).unwrap(); }
    }
}

#[test]
fn checked_native_input_returns_compact_validated_facts_without_output() {
    let f = PortableFixture::new("checked-input-facts");
    let bundle = f.export();
    let before = file_tree(&f.output);
    let input = backup::check_backup_input(&bundle).unwrap();
    let facts: &backup::CheckedBackupSummary = input.summary();
    let manifest = read_manifest(&bundle);
    let total: u64 = manifest["parts"].as_array().unwrap().iter()
        .map(|part| part["bytes"].as_str().unwrap().parse::<u64>().unwrap()).sum();
    assert_eq!(input.path(), fs::canonicalize(&bundle).unwrap());
    assert_eq!(facts.workspace_id, WORKSPACE);
    assert_eq!(facts.format, 1);
    assert_eq!(facts.schema_version, 3);
    assert_eq!(facts.part_count, manifest["parts"].as_array().unwrap().len());
    assert_eq!(facts.total_bytes, total.to_string());
    assert_eq!(file_tree(&f.output), before);
}

#[test]
fn admitted_restore_refuses_an_otherwise_valid_replacement_input_root_before_output() {
    let f = PortableFixture::new("checked-input-root-replaced");
    let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    let original = f.output.join("original-bundle");
    fs::rename(&bundle, &original).unwrap();
    copy_valid_portable_tree(&original, &bundle);
    backup::validate_backup(&bundle).unwrap();
    let before = file_tree(&f.output);
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let choice = backup::NewDirectoryChoice::new(&f.output, "Restored copy").unwrap();
        let (lease, ()) = context.reserve_output(choice, &[bundle.clone()], || Ok(())).unwrap();
        let error = backup::restore_admitted(input, lease).unwrap_err();
        assert_eq!(error.kind, BackupErrorKind::SourceChanged);
        assert!(!f.output.join("Restored copy").exists());
        assert_eq!(file_tree(&f.output), before);
    });
}

#[test]
fn admitted_restore_refuses_same_bytes_manifest_object_replacement_before_output() {
    let f = PortableFixture::new("checked-manifest-replaced");
    let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    let manifest = bundle.join("manifest.json");
    let old = f.output.join("original-manifest.json");
    fs::rename(&manifest, &old).unwrap();
    fs::write(&manifest, fs::read(&old).unwrap()).unwrap();
    backup::validate_backup(&bundle).unwrap();
    let before = file_tree(&f.output);
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let choice = backup::NewDirectoryChoice::new(&f.output, "Restored copy").unwrap();
        let (lease, ()) = context.reserve_output(choice, &[bundle], || Ok(())).unwrap();
        assert_eq!(backup::restore_admitted(input, lease).unwrap_err().kind, BackupErrorKind::SourceChanged);
        assert!(!f.output.join("Restored copy").exists());
        assert_eq!(file_tree(&f.output), before);
    });
}

#[test]
fn admitted_restore_parent_replacement_reaches_no_substitute_or_moved_parent() {
    let f = PortableFixture::new("restore-parent-replaced");
    let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    let parent = f.output.join("chosen-parent");
    let moved = f.output.join("original-parent");
    fs::create_dir(&parent).unwrap();
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let choice = backup::NewDirectoryChoice::new(&parent, "Restored copy").unwrap();
        let (lease, ()) = context.reserve_output(choice, &[bundle], || Ok(())).unwrap();
        fs::rename(&parent, &moved).unwrap();
        fs::create_dir(&parent).unwrap();
        fs::write(parent.join("foreign"), b"substitute sentinel").unwrap();
        assert_eq!(backup::restore_admitted(input, lease).unwrap_err().kind, BackupErrorKind::SourceChanged);
        assert_eq!(fs::read(parent.join("foreign")).unwrap(), b"substitute sentinel");
        assert!(!parent.join("Restored copy").exists());
        assert!(!moved.join("Restored copy").exists());
    });
}

#[test]
fn admitted_restore_holds_real_output_lease_through_publication_and_leaves_both_roots_inactive() {
    let f = PortableFixture::new("admitted-restore-publication");
    let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    let original_input = file_tree(&bundle);
    let container = f.output.join("Restored copy");
    let other = f.output.join("other-opening");
    fs::create_dir(&other).unwrap();
    let other = fs::canonicalize(other).unwrap();
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let choice = backup::NewDirectoryChoice::new(&f.output, "Restored copy").unwrap();
        let (lease, ()) = context.reserve_output(choice, &[bundle.clone()], || Ok(())).unwrap();
        let concurrent = context.clone();
        let output = f.output.clone();
        let other_for_hook = other.clone();
        let reached = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reached_hook = reached.clone();
        let result = backup::with_step_for_test("restore_publish", move |_, _| {
            reached_hook.store(true, std::sync::atomic::Ordering::SeqCst);
            std::thread::spawn(move || {
                let next_output = backup::NewDirectoryChoice::new(&output, "must-stay-busy").unwrap();
                assert_eq!(concurrent.reserve_output(next_output, &[], || Ok(())).err().unwrap().kind, AuthorityErrorKind::Busy);
                assert!(concurrent.request_open(&output).is_err());
                let attempt = concurrent.request_open(&other_for_hook).unwrap();
                crate::run_open_attempt(&concurrent, &attempt, || {
                    concurrent.publish_attempt_with(&attempt, || Ok(())).map_err(|e| e.message)
                }, || Ok(())).unwrap();
            }).join().unwrap();
        }, || backup::restore_admitted(input, lease));
        assert!(reached.load(std::sync::atomic::Ordering::SeqCst), "real restore publication seam was never reached");
        assert_eq!(result.unwrap().workspace_id, WORKSPACE);
        assert_eq!(context.active_root().unwrap(), Some(other));
        let next = backup::NewDirectoryChoice::new(&f.output, "after-restore").unwrap();
        drop(context.reserve_output(next, &[], || Ok(())).unwrap());
    });
    for name in ["Pages", "Workspace data"] {
        let marker: Value = serde_json::from_slice(&fs::read(container.join(name).join(".cerebro/workspace-format.json")).unwrap()).unwrap();
        assert_eq!(marker["state"], "restored_inactive");
    }
    assert_eq!(fs::read(container.join("Pages/page.md")).unwrap(), fs::read(bundle.join("bodies/page.md")).unwrap());
    assert_eq!(database_facts(&container.join("Workspace data/workspace.db")), f.db_facts);
    assert_eq!(file_tree(&bundle), original_input);
}

#[test]
fn admitted_restore_error_retains_preparing_bytes_then_releases_lease_after_resources() {
    let f = PortableFixture::new("admitted-restore-error");
    let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    let container = f.output.join("Restored copy");
    let input_before = file_tree(&bundle);
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let choice = backup::NewDirectoryChoice::new(&f.output, "Restored copy").unwrap();
        let (lease, ()) = context.reserve_output(choice, &[bundle.clone()], || Ok(())).unwrap();
        let error = backup::with_step_for_test("restore_publish", |bodies, _| {
            fs::write(bodies.join(".cerebro/restored-manifest.json"), b"changed owned provenance").unwrap();
        }, || backup::restore_admitted(input, lease)).unwrap_err();
        assert_eq!(error.kind, BackupErrorKind::PartMismatch);
        assert_no_ready(&container.join("Pages"));
        assert_no_ready(&container.join("Workspace data"));
        assert!(container.join("Pages/page.md").is_file());
        let next = backup::NewDirectoryChoice::new(&f.output, "after-error").unwrap();
        drop(context.reserve_output(next, &[], || Ok(())).unwrap());
    });
    assert_eq!(file_tree(&bundle), input_before);
}

#[test]
fn admitted_restore_unwind_keeps_partial_output_and_releases_only_after_worker_unwinds() {
    let f = PortableFixture::new("admitted-restore-unwind");
    let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    let container = f.output.join("Restored copy");
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let choice = backup::NewDirectoryChoice::new(&f.output, "Restored copy").unwrap();
        let (lease, ()) = context.reserve_output(choice, &[bundle], || Ok(())).unwrap();
        let concurrent = context.clone();
        let output = f.output.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            backup::with_step_for_test("restore_publish", move |_, _| {
                std::thread::spawn(move || {
                    let next = backup::NewDirectoryChoice::new(&output, "must-stay-busy").unwrap();
                    assert_eq!(concurrent.reserve_output(next, &[], || Ok(())).err().unwrap().kind, AuthorityErrorKind::Busy);
                }).join().unwrap();
                panic!("synthetic restore worker panic");
            }, || backup::restore_admitted(input, lease))
        }));
        assert!(result.is_err(), "RED refused before the actual publication/unwind boundary");
        assert_no_ready(&container.join("Pages"));
        assert!(container.join("Pages/page.md").is_file());
        let next = backup::NewDirectoryChoice::new(&f.output, "after-unwind").unwrap();
        drop(context.reserve_output(next, &[], || Ok(())).unwrap());
    });
}

#[test]
fn checked_native_input_refuses_same_bytes_manifest_swap_during_actual_validation() {
    let f = PortableFixture::new("checked-manifest-swap-during-validation");
    let bundle = f.export();
    let moved = f.output.join("original-checked-manifest.json");
    let result = backup::with_step_for_test("validate_database_captured", move |root, _| {
        let manifest = root.join("manifest.json");
        fs::rename(&manifest, &moved).unwrap();
        fs::write(&manifest, fs::read(&moved).unwrap()).unwrap();
    }, || backup::check_backup_input(&bundle));
    // The replacement is valid and has identical bytes; identity continuity is
    // the missing requirement, not an invalid fixture or incomplete manifest.
    backup::validate_backup(&bundle).unwrap();
    assert_eq!(result.expect_err("Check blessed a new manifest object during validation").kind, BackupErrorKind::SourceChanged);
}

#[path = "portable_progress_tests.rs"]
mod native_output_progress;

#[path = "portable_sink_tests.rs"]
mod native_copy_terminal;
