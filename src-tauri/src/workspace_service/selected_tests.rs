#![cfg(test)]
//! Fixture-only activation. Exercises the actual existing native command doors.
#[cfg(unix)]
#[path = "paired_tests.rs"]
mod paired;
#[cfg(unix)]
#[path = "selected_metadata_tests.rs"]
mod metadata_requests;
use super::{
    authority,
    types::{selected::*, StoreErrorCode},
};
use crate::vault::{self, testutil};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

const WORKSPACE: &str = "3ee5b6eb-9f80-4bac-9538-f2a0c5938a62";
const RECORD: &str = "4a22406a-07d5-44d8-bc24-b67e61070bea";
const BODY: &str = "\u{feff}---\r\ntype: Agent\r\ntools: ['write_note']\r\n---\r\n# Canonical body\r\n\r\nA [[body-link]] stays body.\r\n";

struct Fixture {
    root: PathBuf,
    origin: PathBuf,
    db: PathBuf,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let root = testutil::temp_vault(&format!("m99-selected-{label}"));
        let origin = testutil::temp_vault(&format!("m99-origin-{label}"));
        let metadata_dir = origin.join("workspaces").join(WORKSPACE);
        fs::create_dir_all(&metadata_dir).unwrap();
        private_dir(&origin);
        private_dir(&origin.join("workspaces"));
        private_dir(&metadata_dir);
        let db = metadata_dir.join("workspace.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(include_str!("selected_schema.sql"))
            .unwrap();
        conn.execute("INSERT INTO workspace VALUES (1,2,?1,1,1)", [WORKSPACE])
            .unwrap();
        let metadata = metadata();
        conn.execute(
            "INSERT INTO records VALUES (?1,?2,1,?3,?4)",
            rusqlite::params![
                RECORD,
                "page.md",
                crate::ledger::sha256_hex(BODY.as_bytes()),
                metadata.to_string()
            ],
        )
        .unwrap();
        drop(conn);
        private_file(&db);
        fs::write(
            origin.join("workspaces/bindings.v1.json"),
            json!({
                "version":1,"bindings":[{"workspaceId":WORKSPACE,"bodyRoot":root.to_str().unwrap()}]
            })
            .to_string(),
        )
        .unwrap();
        private_file(&origin.join("workspaces/bindings.v1.json"));
        testutil::write(&root, "page.md", BODY);
        testutil::write(
            &root,
            ".cerebro/workspace-format.json",
            &json!({
                "format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":WORKSPACE
            })
            .to_string(),
        );
        Self { root, origin, db }
    }
    fn run<T>(&self, run: impl FnOnce() -> T) -> T {
        authority::with_fixture_context(authority::AuthorityContext::new(self.origin.clone()), run)
    }
    fn version(&self) -> SelectedRecordVersion {
        let (revision, body_hash, metadata): (i64, String, String) = self
            .conn()
            .query_row(
                "SELECT revision,body_hash,metadata FROM records WHERE id=?1",
                [RECORD],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        SelectedRecordVersion {
            kind: SelectedAuthorityKind::SqliteMetadata,
            workspace_id: WORKSPACE.into(),
            record_id: RECORD.into(),
            metadata_revision: revision.to_string(),
            metadata_hash: crate::ledger::sha256_hex(metadata.as_bytes()),
            body_hash,
        }
    }
    fn conn(&self) -> Connection {
        Connection::open(&self.db).unwrap()
    }
    fn stored(&self) -> Value {
        let text: String = self
            .conn()
            .query_row("SELECT metadata FROM records WHERE id=?1", [RECORD], |r| {
                r.get(0)
            })
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir_all(&self.origin);
    }
}
#[cfg(unix)]
fn private_dir(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
#[cfg(not(unix))]
fn private_dir(_: &Path) {}
#[cfg(unix)]
fn private_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
#[cfg(not(unix))]
fn private_file(_: &Path) {}
fn metadata() -> Value {
    json!({"kind":"object","value":{
        "type":{"kind":"string","value":"Note"},
        "title":{"kind":"string","value":"Metadata title must not replace body H1"},
        "grant":{"kind":"string","value":"read_only"},
        "empty":{"kind":"null"},
        "nested":{"kind":"object","value":{"null":{"kind":"null"}}},
        "source_system":{"kind":"string","value":"notion"},
        "source_record_id":{"kind":"string","value":"opaque/source"}
    }})
}
fn typed(error: AuthorityError, kind: AuthorityErrorKind) {
    assert_eq!(error.kind, kind);
    assert_eq!(error.code, StoreErrorCode::CapabilityUnavailable);
    assert!(!error.retryable);
    assert!(!error.message.is_empty());
}
fn authority_error(error: CommandReadError) -> AuthorityError {
    match error {
        CommandReadError::Authority(error) => error,
        CommandReadError::Legacy(message) => {
            panic!("selected error was collapsed to legacy string: {message}")
        }
    }
}
fn mutate(
    f: &Fixture,
    version: SelectedRecordVersion,
    mode: SelectedMode,
) -> Result<SelectedMetadataAck, AuthorityError> {
    crate::set_page_full_width(
        f.root.to_str().unwrap().into(),
        "page.md".into(),
        version,
        mode,
    )
}

#[test]
fn actual_scan_and_read_use_canonical_metadata_and_exact_body_even_with_leading_yaml() {
    let f = Fixture::new("actual-read");
    f.run(|| {
        let entries = crate::scan_vault(f.root.to_str().unwrap().into()).unwrap();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.title, "Canonical body");
        assert_eq!(entry.entry_type.as_deref(), Some("Note"));
        assert_eq!(entry.properties["grant"], "read_only");
        assert!(!entry.properties.contains_key("tools"));
        assert_eq!(entry.properties["empty"], Value::Null);
        assert_eq!(entry.properties["nested"]["null"], Value::Null);
        assert_eq!(entry.authority.as_ref(), Some(&f.version()));
        assert!(entry.outgoing_links.contains(&"body-link".into()));
        assert_eq!(
            crate::read_note(f.root.to_str().unwrap().into(), "page.md".into()).unwrap(),
            BODY
        );
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
        assert!(!f.root.join(crate::ledger::LEDGER_DIR).exists());
        assert!(!f.origin.join("runtime.db").exists());
    });
}
#[test]
fn actual_full_width_command_is_cas_receipted_metadata_only_and_preserves_other_values() {
    let f = Fixture::new("actual-metadata");
    f.run(|| {
        // Canonical writer preservation is broader than the legacy UI projection.
        let mut original=f.stored();original["value"]["exact_decimal"]=json!({"kind":"decimal","value":"90071992547409931234567890.001"});
        original["value"]["relation"]=json!({"kind":"relation","spelling":"[[Elsewhere]]","fragment":null,"resolution":{"status":"resolved","targetId":RECORD}});
        f.conn().execute("UPDATE records SET metadata=?1",[original.to_string()]).unwrap();
        let before=f.version();let body=fs::read(f.root.join("page.md")).unwrap();
        let ack=mutate(&f,before.clone(),SelectedMode::Wide).unwrap();
        let SelectedMetadataAck::Applied{version,full_width}=ack else {panic!("a real change must report applied")};
        assert!(full_width);assert_eq!(version.metadata_revision,"2");assert_eq!(version.body_hash,before.body_hash);
        let mut expected=original.clone();expected["value"]["full_width"]=json!({"kind":"boolean","value":true});
        assert_eq!(f.stored(),expected);assert_eq!(fs::read(f.root.join("page.md")).unwrap(),body);
        let noop=mutate(&f,version.clone(),SelectedMode::Wide).unwrap();
        assert_eq!(noop,SelectedMetadataAck::Unchanged{version:version.clone(),full_width:true});
        let count:i64=f.conn().query_row("SELECT COUNT(*) FROM metadata_receipts",[],|r|r.get(0)).unwrap();assert_eq!(count,1);
        let actor:String=f.conn().query_row("SELECT actor FROM metadata_receipts",[],|r|r.get(0)).unwrap();assert_eq!(actor,"human:me");
        typed(mutate(&f,before,SelectedMode::Default).unwrap_err(),AuthorityErrorKind::StaleMetadata);
        let SelectedMetadataAck::Applied{version:after,full_width}=mutate(&f,version,SelectedMode::Default).unwrap() else {panic!("reset changed stored key")};
        assert!(!full_width);assert_eq!(after.metadata_revision,"3");assert_eq!(f.stored(),original);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(),body);
    });
}
#[test]
fn actual_scan_refuses_missing_known_marker_before_orphan_cleanup_and_old_writer_effects() {
    let f = Fixture::new("missing-marker");
    f.run(|| {
        fs::remove_file(f.root.join(".cerebro/workspace-format.json")).unwrap();
        testutil::write(
            &f.root,
            ".page.md.cerebro-tmp-00000000deadbeef",
            "do not reap without authority",
        );
        let then = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(f.root.join(".page.md.cerebro-tmp-00000000deadbeef"))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(then))
            .unwrap();
        typed(
            authority_error(crate::scan_vault(f.root.to_str().unwrap().into()).unwrap_err()),
            AuthorityErrorKind::MissingMarker,
        );
        assert!(f
            .root
            .join(".page.md.cerebro-tmp-00000000deadbeef")
            .exists());
        let by = vault::receipt::WriteReceipt::ipc(
            crate::knowledge::guard_human_write("page.md").unwrap(),
        );
        assert!(
            vault::write::update_frontmatter(&f.root, "page.md", &serde_json::Map::new(), &by)
                .is_err()
        );
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
    });
}
#[test]
fn actual_read_and_mutation_refuse_wrong_identity_body_and_metadata_versions() {
    let f = Fixture::new("versions");
    f.run(|| {
        let original = f.version();
        let mut wrong = original.clone();
        wrong.record_id = WORKSPACE.into();
        typed(
            mutate(&f, wrong, SelectedMode::Wide).unwrap_err(),
            AuthorityErrorKind::WrongIdentity,
        );
        let mut wrong = original.clone();
        wrong.metadata_hash = "a".repeat(64);
        typed(
            mutate(&f, wrong, SelectedMode::Wide).unwrap_err(),
            AuthorityErrorKind::StaleMetadata,
        );
        fs::write(f.root.join("page.md"), "# Outside body edit\r\n").unwrap();
        typed(
            authority_error(
                crate::read_note(f.root.to_str().unwrap().into(), "page.md".into()).unwrap_err(),
            ),
            AuthorityErrorKind::SourceChanged,
        );
        typed(
            mutate(&f, original, SelectedMode::Wide).unwrap_err(),
            AuthorityErrorKind::SourceChanged,
        );
        assert!(!f.stored()["value"]
            .as_object()
            .unwrap()
            .contains_key("full_width"));
        let count: i64 = f
            .conn()
            .query_row("SELECT COUNT(*) FROM metadata_receipts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    });
}
#[test]
fn canonical_metadata_only_change_invalidates_actual_corpus_without_touching_body_stat() {
    let f = Fixture::new("corpus");
    f.run(|| {
        let cache = vault::corpus::CorpusCache::new(1);
        let first = cache.snapshot(&f.root).unwrap();
        assert!(!first.entries[0].properties.contains_key("full_width"));
        let body_stat = fs::metadata(f.root.join("page.md"))
            .unwrap()
            .modified()
            .unwrap();
        mutate(&f, f.version(), SelectedMode::Wide).unwrap();
        let second = cache.snapshot(&f.root).unwrap();
        assert_eq!(second.entries[0].properties["full_width"], true);
        assert_eq!(
            fs::metadata(f.root.join("page.md"))
                .unwrap()
                .modified()
                .unwrap(),
            body_stat
        );
        assert_ne!(first.entries[0].authority, second.entries[0].authority);
        assert!(second.texts[0].body.starts_with('\u{feff}'));
        assert!(second.texts[0].body.contains("type: Agent"));
    });
}
#[test]
fn legacy_absent_marker_and_unbound_format_markers_are_not_conflated() {
    let f = Fixture::new("legacy-boundary");
    f.run(|| {
        let legacy=testutil::temp_vault("m99-selected-legacy-control");testutil::write(&legacy,"a.md","---\ntype: Note\n---\n# Legacy\n");
        let entries=crate::scan_vault(legacy.to_str().unwrap().into()).unwrap();assert_eq!(entries[0].entry_type.as_deref(),Some("Note"));assert!(entries[0].authority.is_none());
        for (raw,kind) in [
            ("{broken",AuthorityErrorKind::InvalidFormat),
            (r#"{"format":999,"authority":"sqlite_metadata","state":"activated"}"#,AuthorityErrorKind::UnsupportedFormat),
            (r#"{"format":1,"authority":"sqlite_metadata","state":"preparing"}"#,AuthorityErrorKind::InactiveWorkspace),
            (r#"{"format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":"3ee5b6eb-9f80-4bac-9538-f2a0c5938a62"}"#,AuthorityErrorKind::UnboundWorkspace),
        ] {testutil::write(&legacy,".cerebro/workspace-format.json",raw);typed(authority_error(crate::scan_vault(legacy.to_str().unwrap().into()).unwrap_err()),kind);}
        fs::remove_dir_all(legacy).unwrap();
    });
}

#[test]
fn actual_scan_never_rounds_or_discards_unrepresentable_property_values() {
    let f = Fixture::new("projection");
    f.run(|| {
        let mut properties=metadata();
        properties["value"]["prose"]=json!({"kind":"string","value":"ordinary [[body-link]] prose"});
        f.conn().execute("UPDATE records SET metadata=?1",[properties.to_string()]).unwrap();
        assert_eq!(crate::scan_vault(f.root.to_str().unwrap().into()).unwrap()[0].properties["prose"],"ordinary [[body-link]] prose");
        for value in [
            json!({"kind":"decimal","value":"0.1"}),
            json!({"kind":"decimal","value":"1e2"}),
            json!({"kind":"decimal","value":"9007199254740992"}),
            json!({"kind":"relation","spelling":"[[page]]","fragment":null,"resolution":{"status":"resolved","targetId":RECORD}}),
        ] {
            properties["value"]["unsupported"]=value;
            f.conn().execute("UPDATE records SET metadata=?1",[properties.to_string()]).unwrap();
            let tagged=super::value::decode_tagged(&properties["value"]["unsupported"].to_string()).unwrap();
            assert!(super::value::legacy_value(&tagged).is_err(),"legacy value conversion remains closed");
            let scanned=crate::scan_vault(f.root.to_str().unwrap().into()).unwrap();
            let wire=serde_json::to_value(&scanned[0]).unwrap();
            assert_eq!(wire["canonicalProperties"]["value"],properties);
            assert!(wire["canonicalProperties"]["unavailableLegacyKeys"].as_array().unwrap().iter().any(|key|key.as_str()==Some("unsupported")));
            assert_eq!(f.stored(),properties);
        }
        properties["value"]["unsupported"]=json!({"kind":"decimal","value":"9007199254740991"});
        f.conn().execute("UPDATE records SET metadata=?1",[properties.to_string()]).unwrap();
        assert_eq!(crate::scan_vault(f.root.to_str().unwrap().into()).unwrap()[0].properties["unsupported"],json!(9007199254740991_i64));
    });
}
#[test]
fn actual_scan_and_writer_require_supported_unmodified_store_schema_and_complete_pairing() {
    let f = Fixture::new("schema");
    f.run(|| {
        let version=f.version();
        f.conn().execute_batch("CREATE TRIGGER extra_effect AFTER UPDATE ON records BEGIN DELETE FROM metadata_receipts; END;").unwrap();
        typed(mutate(&f,version.clone(),SelectedMode::Wide).unwrap_err(),AuthorityErrorKind::InvalidMetadata);
        assert!(!f.stored()["value"].as_object().unwrap().contains_key("full_width"));
        f.conn().execute_batch("DROP TRIGGER extra_effect; PRAGMA user_version=1;").unwrap();
        typed(authority_error(crate::scan_vault(f.root.to_str().unwrap().into()).unwrap_err()),AuthorityErrorKind::UnsupportedFormat);
        f.conn().execute_batch("PRAGMA user_version=2; DELETE FROM records;").unwrap();
        typed(authority_error(crate::scan_vault(f.root.to_str().unwrap().into()).unwrap_err()),AuthorityErrorKind::MetadataUnavailable);
        typed(mutate(&f,version,SelectedMode::Wide).unwrap_err(),AuthorityErrorKind::MetadataUnavailable);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(),BODY.as_bytes());
    });
}

#[test]
fn external_body_edit_at_final_metadata_commit_boundary_rolls_back_revision_and_receipt() {
    let f = Fixture::new("body-race");
    f.run(|| {
        let path = f.root.join("page.md");
        let before = f.version();
        let result = super::selected::with_before_commit_for_test(
            move || fs::write(path, "# Concurrent outside body\r\n").unwrap(),
            || mutate(&f, before.clone(), SelectedMode::Wide),
        );
        typed(result.unwrap_err(), AuthorityErrorKind::SourceChanged);
        assert_eq!(f.version(), before);
        assert!(!f.stored()["value"]
            .as_object()
            .unwrap()
            .contains_key("full_width"));
        let count: i64 = f
            .conn()
            .query_row("SELECT COUNT(*) FROM metadata_receipts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(
            fs::read_to_string(f.root.join("page.md")).unwrap(),
            "# Concurrent outside body\r\n"
        );
    });
}

#[test]
fn actual_projection_replays_all_shared_exact_value_cases() {
    let table: Value =
        serde_json::from_str(include_str!("../../../shared/workspace/authority.v2.json")).unwrap();
    for case in table["projectionCases"].as_array().unwrap() {
        let value = super::value::decode_tagged(&case["source"].to_string()).unwrap();
        let result = super::value::legacy_value(&value);
        if case.get("expected").is_some() {
            assert_eq!(result.unwrap(), case["expected"], "{}", case["name"]);
        } else {
            assert!(result.is_err(), "{}", case["name"]);
        }
    }
}

#[test]
fn actual_full_width_transaction_replays_shared_one_key_cases() {
    let table: Value =
        serde_json::from_str(include_str!("../../../shared/workspace/authority.v2.json")).unwrap();
    for (index, case) in table["fullWidthCases"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let f = Fixture::new(&format!("shared-full-width-{index}"));
        f.run(|| {
            f.conn()
                .execute(
                    "UPDATE records SET metadata=?1",
                    [case["before"].to_string()],
                )
                .unwrap();
            let mode = serde_json::from_value(case["mode"].clone()).unwrap();
            let ack = mutate(&f, f.version(), mode).unwrap();
            assert_eq!(f.stored(), case["expected"], "{}", case["name"]);
            let changed = case["changed"].as_bool().unwrap();
            assert_eq!(matches!(ack, SelectedMetadataAck::Applied { .. }), changed);
            let receipts: i64 = f
                .conn()
                .query_row("SELECT COUNT(*) FROM metadata_receipts", [], |r| r.get(0))
                .unwrap();
            assert_eq!(receipts, i64::from(changed));
        });
    }
}

#[test]
fn observed_selected_binding_disappearance_cannot_reenable_legacy_reads_writes_or_exports() {
    let f = Fixture::new("observed-disappearance");
    f.run(|| {
        crate::scan_vault(f.root.to_str().unwrap().into()).unwrap();
        let expected = f.version();
        fs::remove_file(f.origin.join("workspaces/bindings.v1.json")).unwrap();
        fs::remove_file(f.root.join(".cerebro/workspace-format.json")).unwrap();
        let scan = crate::scan_vault(f.root.to_str().unwrap().into());
        let read = crate::read_note(f.root.to_str().unwrap().into(), "page.md".into());
        let mutation = mutate(&f, expected, SelectedMode::Wide);
        let by = vault::receipt::WriteReceipt::ipc(
            crate::knowledge::guard_human_write("page.md").unwrap(),
        );
        let legacy = vault::write::update_frontmatter(
            &f.root,
            "page.md",
            &serde_json::Map::from_iter([("full_width".into(), json!(true))]),
            &by,
        );
        let export = super::native_admission::publish_export(
            &authority::context().unwrap(),
            &f.root.join("forbidden.csv"),
            b"must not publish",
        );
        assert!(
            scan.is_err()
                && read.is_err()
                && mutation.is_err()
                && legacy.is_err()
                && export.is_err(),
            "scanDenied={},readDenied={},metadataDenied={},legacyDenied={},exportDenied={}",
            scan.is_err(),
            read.is_err(),
            mutation.is_err(),
            legacy.is_err(),
            export.is_err()
        );
        typed(
            authority_error(scan.unwrap_err()),
            AuthorityErrorKind::BindingUnavailable,
        );
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
        assert!(!f.root.join("forbidden.csv").exists());
        let unknown = testutil::temp_vault("m99-observed-unknown-legacy");
        testutil::write(&unknown, "a.md", "# Still legacy\n");
        assert!(
            crate::scan_vault(unknown.to_str().unwrap().into()).unwrap()[0]
                .authority
                .is_none()
        );
        fs::remove_dir_all(unknown).unwrap();
    });
    // A fresh context has no observed authority evidence. This is deliberately not
    // durable restart/tamper protection when both authoritative records disappeared.
    f.run(|| {
        assert!(
            crate::scan_vault(f.root.to_str().unwrap().into()).unwrap()[0]
                .authority
                .is_none()
        )
    });
}
#[test]
fn observed_selected_binding_reassignment_is_a_denial_and_canonical_aliases_share_it() {
    let f = Fixture::new("observed-reassignment");
    f.run(||{
  crate::scan_vault(f.root.to_str().unwrap().into()).unwrap();
  fs::write(f.origin.join("workspaces/bindings.v1.json"),json!({"version":1,"bindings":[{"workspaceId":"5e42a681-f796-4cd8-83c4-ab8285fcce35","bodyRoot":f.root}]}).to_string()).unwrap();fs::remove_file(f.root.join(".cerebro/workspace-format.json")).unwrap();
  let path={#[cfg(unix)] {let alias=f.origin.join("body-alias");std::os::unix::fs::symlink(&f.root,&alias).unwrap();alias}#[cfg(not(unix))]{f.root.clone()}};
  typed(authority_error(crate::scan_vault(path.to_str().unwrap().into()).unwrap_err()),AuthorityErrorKind::WrongIdentity);
 });
}

#[test]
fn actual_retained_carrier_and_folder_commands_preserve_bytes_and_project_scope() {
    let f = Fixture::new("retained-carriers");
    f.run(|| {
        let project = "# Project body\r\n";
        testutil::write(&f.root, "work/project.md", project);
        f.conn()
            .execute(
                "INSERT INTO records VALUES (?1,'work/project.md',1,?2,?3)",
                rusqlite::params![
                    "905c5b49-a598-4800-bd79-f2a786ae34bc",
                    crate::ledger::sha256_hex(project.as_bytes()),
                    metadata().to_string()
                ],
            )
            .unwrap();
        let collection = "\u{feff}title: Exact collection\r\nunknown: [keep, all]\r\n";
        let yaml = "\u{feff}title: Exact view\r\nfuture: {preserved: true}\r\n";
        testutil::write(&f.root, "work/collection.yml", collection);
        testutil::write(&f.root, "views/global.yml", yaml);
        testutil::write(&f.root, "work/views/legacy.yml", yaml);
        testutil::write(&f.root, "work/items.list.yml", yaml);
        let views = crate::list_views(f.root.to_str().unwrap().into()).unwrap();
        assert_eq!(views.len(), 3);
        assert!(views.iter().all(|view| view.yaml == yaml));
        assert!(views
            .iter()
            .any(|view| view.id == "legacy" && view.project.as_deref() == Some("work/project.md")));
        assert!(views
            .iter()
            .any(|view| view.id == "items" && view.collection.as_deref() == Some("work")));
        let collections = crate::list_collections(f.root.to_str().unwrap().into()).unwrap();
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].folder, "work");
        assert_eq!(collections[0].yaml, collection);
        assert_eq!(
            crate::list_folders(f.root.to_str().unwrap().into()).unwrap(),
            vec!["work"]
        );
        fs::write(
            f.root.join("work/items.list.yml"),
            vec![b'x'; super::authority::rules().limits.retained_carrier_bytes as usize + 1],
        )
        .unwrap();
        assert!(crate::list_views(f.root.to_str().unwrap().into()).is_err());
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
    });
}
#[test]
fn actual_retained_view_ownership_uses_canonical_folder_note_type_not_injected_body_yaml() {
    let f = Fixture::new("retained-collection-type");
    f.run(|| {
        let body = "---\r\ntype: Collection\r\n---\r\n# Visible body\r\n";
        testutil::write(&f.root, "work/work.md", body);
        testutil::write(&f.root, "work/items.list.yml", "title: Items\r\n");
        f.conn()
            .execute(
                "INSERT INTO records VALUES (?1,'work/work.md',1,?2,?3)",
                rusqlite::params![
                    "905c5b49-a598-4800-bd79-f2a786ae34bc",
                    crate::ledger::sha256_hex(body.as_bytes()),
                    metadata().to_string()
                ],
            )
            .unwrap();
        let views = crate::list_views(f.root.to_str().unwrap().into()).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].collection, None);
        let mut canonical = metadata();
        canonical["value"]["type"] = json!({"kind":"string","value":"Collection"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1,revision=2 WHERE path='work/work.md'",
                [canonical.to_string()],
            )
            .unwrap();
        f.conn()
            .execute("UPDATE workspace SET metadata_epoch=2", [])
            .unwrap();
        let views = crate::list_views(f.root.to_str().unwrap().into()).unwrap();
        assert_eq!(views[0].collection.as_deref(), Some("work"));
        assert_eq!(
            fs::read(f.root.join("work/work.md")).unwrap(),
            body.as_bytes()
        );
    });
}

#[test]
fn observed_binding_cap_refuses_excess_without_evicting_prior_denial_identity() {
    let f = Fixture::new("observed-cap");
    let pool = testutil::temp_vault("m99-observed-cap-pool");
    f.run(||{
  crate::scan_vault(f.root.to_str().unwrap().into()).unwrap();
  for index in 0..super::authority::rules().limits.registry_bindings {
   let root=pool.join(index.to_string());testutil::write(&root,"page.md",BODY);testutil::write(&root,".cerebro/workspace-format.json",&json!({"format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":WORKSPACE}).to_string());
   fs::write(f.origin.join("workspaces/bindings.v1.json"),json!({"version":1,"bindings":[{"workspaceId":WORKSPACE,"bodyRoot":root}]}).to_string()).unwrap();
   let result=crate::scan_vault(root.to_str().unwrap().into());
   if index+1==super::authority::rules().limits.registry_bindings {typed(authority_error(result.unwrap_err()),AuthorityErrorKind::SourceLimit);}else{assert!(result.is_ok());}
  }
  fs::remove_file(f.origin.join("workspaces/bindings.v1.json")).unwrap();fs::remove_file(f.root.join(".cerebro/workspace-format.json")).unwrap();
  typed(authority_error(crate::scan_vault(f.root.to_str().unwrap().into()).unwrap_err()),AuthorityErrorKind::BindingUnavailable);
  let unknown=pool.join("unbound-legacy");testutil::write(&unknown,"a.md","# Unknown legacy\n");assert!(crate::scan_vault(unknown.to_str().unwrap().into()).unwrap()[0].authority.is_none());
 });
    fs::remove_dir_all(pool).unwrap();
}

#[test]
fn actual_occurrence_command_refuses_selected_before_source_snapshot_and_keeps_legacy_reads() {
    let f = Fixture::new("occurrence-command");
    f.run(|| {
        // Missing canonical DB would fail a corpus snapshot. The command must
        // refuse this unadopted selected door before attempting that snapshot.
        fs::remove_file(&f.db).unwrap();
        for mode in [
            crate::source_occurrences::OccurrenceMode::Linked,
            crate::source_occurrences::OccurrenceMode::Mention,
        ] {
            let error = crate::find_source_occurrences(
                f.root.to_str().unwrap().into(),
                "page.md".into(),
                mode,
                None,
            )
            .unwrap_err();
            assert_eq!(
                error,
                "This operation is not supported for selected metadata workspaces."
            );
        }
        let legacy = testutil::temp_vault("m99-occurrence-human-legacy");
        testutil::write(&legacy, "source.md", "# Source\n[[target]] and target.\n");
        testutil::write(&legacy, "target.md", "# Target\n");
        for mode in [
            crate::source_occurrences::OccurrenceMode::Linked,
            crate::source_occurrences::OccurrenceMode::Mention,
        ] {
            let page = serde_json::to_value(
                crate::find_source_occurrences(
                    legacy.to_str().unwrap().into(),
                    "target.md".into(),
                    mode,
                    None,
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(page["status"], "ready");
            assert_eq!(page["rows"].as_array().unwrap().len(), 1);
            assert_eq!(
                page["rows"][0]["location"]["vaultId"],
                crate::runtime::scope::derive_vault_id(&legacy)
            );
        }
        fs::remove_dir_all(legacy).unwrap();
    });
}

#[test]
fn installed_metadata_namespace_denies_ancestor_and_alias_without_blocking_other_app_data() {
    let f = Fixture::new("namespace-containment");
    f.run(|| {
        let context = authority::context().unwrap();
        let guard = super::native_admission::guard_external_write;
        let metadata = f.origin.join("workspaces");
        assert!(guard(&context, &metadata).is_err());
        assert!(guard(&context, &f.origin).is_err());
        #[cfg(unix)]
        {
            let alias = f.root.join("metadata-alias");
            std::os::unix::fs::symlink(&metadata, &alias).unwrap();
            assert!(guard(&context, &alias.join("new-id/workspace.db")).is_err());
        }
        fs::remove_file(metadata.join("bindings.v1.json")).unwrap();
        assert!(guard(&context, &metadata.join("bindings.v1.json")).is_err());
        assert!(guard(&context, &f.origin).is_err());
        guard(&context, &f.origin.join("ordinary-export.csv")).unwrap();
        // Even the namespace directory's absence cannot authorize recreation.
        fs::remove_dir_all(&metadata).unwrap();
        assert!(guard(&context, &metadata.join("bindings.v1.json")).is_err());
        guard(&context, &f.origin.join("ordinary-export.csv")).unwrap();
    });
}

#[test]
fn full_width_cannot_commit_past_aggregate_metadata_read_bound() {
    let f = Fixture::new("aggregate-write-bound");
    let empty = json!({"kind":"object","value":{}}).to_string();
    let max = super::value::max_source_bytes();
    let aggregate = super::authority::rules().limits.aggregate_metadata_bytes;
    let padding_base =
        json!({"kind":"object","value":{"padding":{"kind":"string","value":""}}}).to_string();
    let filler = |length: usize| {
        let source = json!({"kind":"object","value":{"padding":{"kind":"string","value":"x".repeat(length-padding_base.len())}}}).to_string();
        assert_eq!(source.len(), length);
        super::value::decode_tagged(&source).unwrap();
        source
    };
    let conn = f.conn();
    conn.execute(
        "UPDATE records SET metadata=?1 WHERE id=?2",
        rusqlite::params![empty, RECORD],
    )
    .unwrap();
    let mut remaining = aggregate - empty.len();
    let mut index = 0;
    while remaining > 0 {
        let bytes = remaining.min(max);
        let id = format!("50000000-0000-4000-8000-{index:012x}");
        let path = format!("filler-{index}.md");
        testutil::write(&f.root, &path, BODY);
        conn.execute(
            "INSERT INTO records VALUES (?1,?2,1,?3,?4)",
            rusqlite::params![
                id,
                path,
                crate::ledger::sha256_hex(BODY.as_bytes()),
                filler(bytes)
            ],
        )
        .unwrap();
        remaining -= bytes;
        index += 1;
    }
    drop(conn);
    f.run(|| {
        // Confirm an existing valid, readable workspace before the mutation.
        crate::read_note(f.root.to_str().unwrap().into(), "page.md".into()).unwrap();
        let before = f.version();
        let result = mutate(&f, before.clone(), SelectedMode::Wide);
        // Expected RED: current implementation instead returns Applied.
        typed(result.unwrap_err(), AuthorityErrorKind::SourceLimit);
        assert_eq!(f.version(), before);
        assert_eq!(
            f.conn()
                .query_row("SELECT count(*) FROM metadata_receipts", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        crate::read_note(f.root.to_str().unwrap().into(), "page.md".into()).unwrap();
    });
}

// A paired intent blocks existing selected readers and metadata writers.
fn pending_pair_fixture(f: &Fixture) -> std::path::PathBuf {
    let old = fs::read(f.root.join("page.md")).unwrap();
    let after = b"# Intended body\n";
    let before = f.version();
    let metadata: String = f
        .conn()
        .query_row("SELECT metadata FROM records WHERE id=?1", [RECORD], |r| {
            r.get(0)
        })
        .unwrap();
    let intent = json!({
        "format":1,
        "operation_id":"8fc1e7a1-66be-43f6-9d4f-cff8b2f79b0d",
        "workspace_id":WORKSPACE,
        "body_root":f.root.to_str().unwrap(),
        "database":f.db.to_str().unwrap(),
        "selected_schema":3,
        "record_id":RECORD,
        "path":"page.md",
        "schema_revision":1,
        "before_revision":1,
        "after_revision":2,
        "before_epoch":1,
        "after_epoch":2,
        "metadata_source":metadata,
        "metadata_hash":before.metadata_hash,
        "before_body":{"name":"before.body","length":old.len(),"hash":before.body_hash},
        "after_body":{"name":"after.body","length":after.len(),"hash":crate::ledger::sha256_hex(after)},
        "receipt":{
            "workspace_id":WORKSPACE,
            "epoch":2,
            "record_id":RECORD,
            "previous_revision":1,
            "revision":2,
            "metadata_before_hash":before.metadata_hash,
            "metadata_after_hash":before.metadata_hash,
            "body_before_hash":before.body_hash,
            "body_after_hash":crate::ledger::sha256_hex(after),
            "actor":"human:me",
            "run_id":null,
            "approved_by":null,
            "operation":"page.body",
            "at":"2026-10-24T00:00:00+00:00"
        }
    });
    let pending = f.db.parent().unwrap().join("pending-change");
    fs::create_dir(&pending).unwrap();
    private_dir(&pending);
    for (name, bytes) in [
        ("intent.json", serde_json::to_vec(&intent).unwrap()),
        ("before.body", old),
        ("after.body", after.to_vec()),
    ] {
        let path = pending.join(name);
        fs::write(&path, bytes).unwrap();
        private_file(&path);
    }
    pending
}

#[test]
fn selected_read_refuses_a_pending_paired_change_before_returning_body() {
    let f = Fixture::new("pending-read-causal");
    let pending = pending_pair_fixture(&f);
    let database = fs::read(&f.db).unwrap();
    let intent = fs::read(pending.join("intent.json")).unwrap();
    f.run(|| {
        let direct = super::selected::read_body(&f.root, "page.md");
        let command = crate::read_note(f.root.to_str().unwrap().into(), "page.md".into());
        let scan = crate::scan_vault(f.root.to_str().unwrap().into());
        let corpus = super::selected::corpus_snapshot(&f.root);
        assert_eq!(fs::read(&f.db).unwrap(), database);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
        assert_eq!(fs::read(pending.join("intent.json")).unwrap(), intent);
        assert_eq!(
            fs::read(pending.join("before.body")).unwrap(),
            BODY.as_bytes()
        );
        assert_eq!(
            fs::read(pending.join("after.body")).unwrap(),
            b"# Intended body\n"
        );
        assert!(direct.is_err(), "selected::read_body exposed pending pair");
        assert!(command.is_err(), "read_note exposed pending pair");
        assert!(scan.is_err(), "scan_vault exposed pending pair");
        assert!(corpus.is_err(), "corpus_snapshot exposed pending pair");
    });
}

#[test]
fn full_width_does_not_advance_canonical_metadata_while_paired_recovery_is_pending() {
    let f = Fixture::new("pending-full-width-causal");
    let before = f.version();
    let metadata = f.stored();
    let database = fs::read(&f.db).unwrap();
    let pending = pending_pair_fixture(&f);
    let intent = fs::read(pending.join("intent.json")).unwrap();
    f.run(|| {
        let result = mutate(&f, before.clone(), SelectedMode::Wide);
        // These fixture SQL inspections are intentionally independent of the
        // selected read guard; the four read APIs above are the consumers.
        let (revision, body_hash, metadata_source): (i64, String, String) = f
            .conn()
            .query_row(
                "SELECT revision,body_hash,metadata FROM records WHERE id=?1",
                [RECORD],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let receipts: i64 = f
            .conn()
            .query_row("SELECT count(*) FROM metadata_receipts", [], |r| r.get(0))
            .unwrap();
        let epoch: i64 = f
            .conn()
            .query_row("SELECT metadata_epoch FROM workspace", [], |r| r.get(0))
            .unwrap();
        assert!(
            result.is_err(),
            "Full width acknowledged a pending pair: {result:?}"
        );
        assert_eq!(revision.to_string(), before.metadata_revision);
        assert_eq!(body_hash, before.body_hash);
        assert_eq!(
            crate::ledger::sha256_hex(metadata_source.as_bytes()),
            before.metadata_hash
        );
        assert_eq!(
            serde_json::from_str::<Value>(&metadata_source).unwrap(),
            metadata
        );
        assert_eq!(epoch, 1);
        assert_eq!(receipts, 0);
        assert_eq!(fs::read(&f.db).unwrap(), database);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
        assert_eq!(fs::read(pending.join("intent.json")).unwrap(), intent);
        assert_eq!(
            fs::read(pending.join("before.body")).unwrap(),
            BODY.as_bytes()
        );
        assert_eq!(
            fs::read(pending.join("after.body")).unwrap(),
            b"# Intended body\n"
        );
    });
}

#[test]
fn startup_v2_recovery_is_a_read_only_noop_without_a_new_lock() {
    let f = Fixture::new("startup-v2-clean");
    let database = fs::read(&f.db).unwrap();
    let marker = fs::read(f.root.join(".cerebro/workspace-format.json")).unwrap();
    let registry = fs::read(f.origin.join("workspaces/bindings.v1.json")).unwrap();
    let permissions = fs::metadata(&f.db).unwrap().permissions();
    f.run(|| {
        assert_eq!(
            crate::workspace_migration::recovery::recover_workspace(&f.root).unwrap(),
            crate::workspace_service::selected::RecoveryReport::Clean
        );
        crate::prepare_selected_open(&f.root).unwrap();
        assert_eq!(
            crate::workspace_service::selected::read_body(&f.root, "page.md").unwrap(),
            BODY
        );
    });
    assert_eq!(fs::read(&f.db).unwrap(), database);
    assert_eq!(fs::metadata(&f.db).unwrap().permissions(), permissions);
    assert_eq!(
        fs::read(f.root.join(".cerebro/workspace-format.json")).unwrap(),
        marker
    );
    assert_eq!(
        fs::read(f.origin.join("workspaces/bindings.v1.json")).unwrap(),
        registry
    );
    assert_eq!(fs::read_dir(f.db.parent().unwrap()).unwrap().count(), 1);
    assert!(!f.db.parent().unwrap().join("selected.lock").exists());
}

#[test]
fn startup_v2_recovery_refuses_pending_file_and_directory_without_mutation() {
    for directory in [false, true] {
        let f = Fixture::new("startup-v2-pending");
        let database = fs::read(&f.db).unwrap();
        let pending = f.db.parent().unwrap().join("pending-change");
        let evidence = if directory {
            fs::create_dir(&pending).unwrap();
            private_dir(&pending);
            pending.join("intent.json")
        } else {
            pending.clone()
        };
        fs::write(&evidence, b"uninterpreted-v2-evidence").unwrap();
        private_file(&evidence);
        f.run(|| {
            let result = crate::workspace_migration::recovery::recover_workspace(&f.root);
            assert_eq!(
                result.unwrap_err().kind,
                AuthorityErrorKind::RecoveryRequired
            );
            assert!(crate::prepare_selected_open(&f.root).is_err());
        });
        assert_eq!(fs::read(&f.db).unwrap(), database);
        assert_eq!(fs::read(&evidence).unwrap(), b"uninterpreted-v2-evidence");
        assert!(!f.db.parent().unwrap().join("selected.lock").exists());
    }
}

#[test]
fn startup_recovery_never_treats_an_unknown_schema_as_clean() {
    let f = Fixture::new("startup-unknown-schema");
    f.conn().pragma_update(None, "user_version", 999).unwrap();
    let database = fs::read(&f.db).unwrap();
    f.run(|| {
        assert_eq!(
            crate::workspace_migration::recovery::recover_workspace(&f.root)
                .unwrap_err()
                .kind,
            AuthorityErrorKind::UnsupportedFormat
        );
        assert_eq!(
            crate::prepare_selected_open(&f.root).unwrap_err().kind,
            AuthorityErrorKind::UnsupportedFormat
        );
    });
    assert_eq!(fs::read(&f.db).unwrap(), database);
    assert!(!f.db.parent().unwrap().join("selected.lock").exists());
}

#[cfg(not(unix))]
#[test]
fn startup_portable_v3_refuses_without_creating_a_lock_or_changing_evidence() {
    let f = Fixture::new("startup-portable-v3");
    fs::remove_file(&f.db).unwrap();
    let conn = Connection::open(&f.db).unwrap();
    conn.execute_batch(include_str!("selected_schema_v3.sql"))
        .unwrap();
    drop(conn);
    let database = fs::read(&f.db).unwrap();
    f.run(|| {
        assert_eq!(
            crate::workspace_migration::recovery::recover_workspace(&f.root)
                .unwrap_err()
                .kind,
            AuthorityErrorKind::UnsupportedOperation
        );
        assert_eq!(
            crate::prepare_selected_open(&f.root).unwrap_err().kind,
            AuthorityErrorKind::UnsupportedOperation
        );
    });
    assert_eq!(fs::read(&f.db).unwrap(), database);
    assert!(!f.db.parent().unwrap().join("selected.lock").exists());
}

#[cfg(unix)]
#[path = "selected_search_tests.rs"]
mod selected_search_reads;
