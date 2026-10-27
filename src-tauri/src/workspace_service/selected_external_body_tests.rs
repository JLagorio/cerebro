#![cfg(test)]
//! Actual native presentation/start/save seams. No new production API is needed
//! for RED; the proposed observation field is asserted on serialized output.
use super::*;
use std::collections::BTreeMap;

const NEIGHBOR_B: &str = "70000000-0000-4000-8000-000000000001";
const NEIGHBOR_C: &str = "70000000-0000-4000-8000-000000000002";
const PROJECT: &str = "70000000-0000-4000-8000-000000000003";
const COLLECTION: &str = "70000000-0000-4000-8000-000000000004";
const OLD_NEIGHBOR: &str = "# Original neighbor\n";
const EXTERNAL_C: &str = "\u{feff}---\r\ntype: Collection\r\n---\r\n# External C\r\n";

fn hash(bytes: &[u8]) -> String {
    crate::ledger::sha256_hex(bytes)
}

fn ordinary_metadata() -> String {
    // Absence, explicit null and a numeric-looking string remain distinct.
    json!({"kind":"object","value":{
        "code":{"kind":"string","value":"007"},
        "present":{"kind":"null"}
    }})
    .to_string()
}

fn add_record(f: &Fixture, id: &str, path: &str, body: &str, metadata: &str) {
    testutil::write(&f.root, path, body);
    f.conn()
        .execute(
            "INSERT INTO records VALUES (?1,?2,1,?3,?4)",
            rusqlite::params![id, path, hash(body.as_bytes()), metadata],
        )
        .unwrap();
}

fn with_neighbors(label: &str, external: bool) -> Fixture {
    let f = fixture(label);
    let metadata = ordinary_metadata();
    add_record(&f, NEIGHBOR_B, "b.md", OLD_NEIGHBOR, &metadata);
    add_record(&f, NEIGHBOR_C, "c.md", OLD_NEIGHBOR, &metadata);
    if external {
        fs::write(f.root.join("b.md"), EXTERNAL).unwrap();
        fs::write(f.root.join("c.md"), EXTERNAL_C).unwrap();
    }
    f
}

type RecordRows = Vec<(String, String, i64, String, String)>;

fn rows(f: &Fixture) -> RecordRows {
    let conn = f.conn();
    let mut statement = conn
        .prepare("SELECT id,path,revision,body_hash,metadata FROM records ORDER BY path")
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap();
    rows.collect::<Result<Vec<_>, _>>().unwrap()
}

// The read-only controls compare all fixture file bytes, names and modes,
// including the canonical database, bindings, bodies and recovery database.
// Hash each file separately so the aggregate-limit case does not retain 128 MiB
// of preimages in memory. This proves durable nonmutation, not syscall tracing.
fn durable_files(f: &Fixture) -> BTreeMap<String, (String, u64, u32)> {
    use std::os::unix::fs::PermissionsExt;
    let mut files = BTreeMap::new();
    for (name, base) in [("vault", &f.root), ("private", &f.origin)] {
        for item in walkdir::WalkDir::new(base).follow_links(false) {
            let item = item.unwrap();
            let path = item.path();
            let relative = path.strip_prefix(base).unwrap();
            let key = format!("{name}/{}", relative.to_string_lossy());
            let metadata = fs::symlink_metadata(path).unwrap();
            let (identity, bytes) = if metadata.file_type().is_symlink() {
                (
                    format!("link:{}", fs::read_link(path).unwrap().display()),
                    0,
                )
            } else if metadata.is_dir() {
                ("directory".into(), 0)
            } else {
                let bytes = fs::read(path).unwrap();
                (hash(&bytes), bytes.len() as u64)
            };
            files.insert(key, (identity, bytes, metadata.permissions().mode()));
        }
    }
    files
}

fn assert_no_publication(f: &Fixture) {
    assert_eq!(receipt_count(f), 0);
    assert_eq!(count_copies(f, "pending"), 0);
    assert_eq!(count_copies(f, "committed"), 0);
    assert!(!pending(f).exists());
}

fn command(
    f: &Fixture,
    journal: &Journal,
    body: &str,
    request: EditorSaveRequest,
) -> Result<crate::NoteSaveResult, Value> {
    crate::save_note_with_editor_journal(
        Ok(journal),
        crate::NoteSaveInput {
            vault: f.root.to_string_lossy().into_owned(),
            path: "page.md".into(),
            body: body.into(),
            expect_hash: None,
            body_format: Some("source".into()),
            recovery_bypass: None,
            editor_request: Some(request),
        },
    )
    .map_err(|error| serde_json::to_value(error).unwrap())
}

fn assert_unpaired_entry(entry: &crate::vault::entry::Entry, body: &str, canonical_hash: &str) {
    let observed = hash(body.as_bytes());
    assert_ne!(observed, canonical_hash);
    assert_eq!(entry.hash.as_deref(), Some(observed.as_str()));
    assert_eq!(entry.authority.as_ref().unwrap().body_hash, canonical_hash);
    let wire = serde_json::to_value(entry).unwrap();
    assert_eq!(
        wire["bodyObservation"],
        json!({"coherence":"external_change","observedBodyHash":observed})
    );
}

#[test]
fn external_presentation_actual_scan_keeps_complete_observations_and_canonical_pairings() {
    let f = with_neighbors("external-presentation-scan", true);
    f.run(|| {
        let _journal = journal(&f, true);
        fs::write(f.root.join("page.md"), EXTERNAL).unwrap();
        let canonical = f.version();
        let before_rows = rows(&f);
        let before_files = durable_files(&f);
        let entries = crate::scan_vault(f.root.to_string_lossy().into_owned())
            .expect("human presentation must report known external bodies without adopting them");
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["b.md", "c.md", "page.md", "task-type.md"]
        );
        let page = entries
            .iter()
            .find(|entry| entry.path == "page.md")
            .unwrap();
        assert_unpaired_entry(page, EXTERNAL, &canonical.body_hash);
        assert_eq!(page.authority.as_ref().unwrap(), &canonical);
        assert_eq!(page.entry_type.as_deref(), Some("Task"));
        assert_eq!(page.properties["code"], "007");
        assert_eq!(page.properties["present"], Value::Null);
        assert!(!page.properties.contains_key("tools"));
        assert_eq!(page.title, "External B");
        for (path, body) in [("b.md", EXTERNAL), ("c.md", EXTERNAL_C)] {
            let entry = entries.iter().find(|entry| entry.path == path).unwrap();
            assert_unpaired_entry(entry, body, &hash(OLD_NEIGHBOR.as_bytes()));
            assert!(entry.entry_type.is_none(), "body YAML cannot create a type");
        }
        let declaration = entries
            .iter()
            .find(|entry| entry.path == "task-type.md")
            .unwrap();
        assert_eq!(
            declaration.hash.as_deref(),
            Some(hash(b"# Task\n").as_str())
        );
        assert_eq!(
            serde_json::to_value(declaration).unwrap()["bodyObservation"],
            json!({"coherence":"paired","observedBodyHash":hash(b"# Task\n")})
        );
        assert_eq!(rows(&f), before_rows);
        assert_eq!(durable_files(&f), before_files);
        assert_no_publication(&f);
    });
}

#[test]
fn external_presentation_actual_list_views_preserves_canonical_scope_without_adoption() {
    let f = with_neighbors("external-presentation-views", true);
    f.run(|| {
        let _journal = journal(&f, true);
        add_record(
            &f,
            PROJECT,
            "work/project.md",
            "# Project\n",
            &ordinary_metadata(),
        );
        add_record(
            &f,
            COLLECTION,
            "work/work.md",
            "# Collection\n",
            r#"{"kind":"object","value":{"type":{"kind":"string","value":"Collection"}}}"#,
        );
        let yaml = "\u{feff}title: Exact retained view\r\nfuture: {keep: true}\r\n";
        testutil::write(&f.root, "views/global.yml", yaml);
        testutil::write(&f.root, "work/views/legacy.yml", yaml);
        testutil::write(&f.root, "work/items.list.yml", yaml);
        let before = durable_files(&f);
        let before_rows = rows(&f);
        let views = crate::list_views(f.root.to_string_lossy().into_owned())
            .expect("known ordinary body drift must not hide retained views");
        assert_eq!(views.len(), 3);
        assert!(views.iter().all(|view| view.yaml == yaml));
        assert!(views.iter().any(|view| {
            view.id == "legacy" && view.project.as_deref() == Some("work/project.md")
        }));
        assert!(views
            .iter()
            .any(|view| { view.id == "items" && view.collection.as_deref() == Some("work") }));
        assert!(views.iter().any(|view| {
            view.id == "global" && view.project.is_none() && view.collection.is_none()
        }));
        assert!(
            crate::list_collections(f.root.to_string_lossy().into_owned())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            crate::list_folders(f.root.to_string_lossy().into_owned()).unwrap(),
            vec!["work"]
        );
        assert_eq!(rows(&f), before_rows);
        assert_eq!(durable_files(&f), before);
        assert_no_publication(&f);
    });
}

#[test]
fn external_presentation_actual_startup_accepts_complete_drift_without_a_new_operation() {
    for protected in [false, true] {
        let f = with_neighbors("external-presentation-startup", true);
        f.run(|| {
            let journal = journal(&f, true);
            let before = durable_files(&f);
            let before_rows = rows(&f);
            let result = if protected {
                crate::prepare_selected_open_with_retention(&f.root, Some(&journal))
            } else {
                crate::prepare_selected_open(&f.root)
            };
            result.expect("ordinary body drift is presentation, not an unfinished original intent");
            assert_eq!(state(&f), (11, 5, 7));
            assert_eq!(rows(&f), before_rows);
            assert_eq!(durable_files(&f), before);
            assert_no_publication(&f);
        });
    }
}

#[test]
fn external_presentation_editor_read_stays_observational_and_strict_services_stay_closed() {
    let f = with_neighbors("external-presentation-strict", true);
    f.run(|| {
        let _journal = journal(&f, true);
        fs::write(f.root.join("page.md"), EXTERNAL).unwrap();
        let canonical = f.version();
        let before = durable_files(&f);
        let read = crate::read_editor_body(
            f.root.to_string_lossy().into_owned(),
            "page.md".into(),
            target(),
        )
        .unwrap();
        assert_eq!(read.body, EXTERNAL);
        assert_eq!(read.observed_body_hash, hash(EXTERNAL.as_bytes()));
        assert_eq!(read.coherence, EditorBodyCoherence::ExternalChange);
        assert_eq!(read.version, canonical);
        assert!(read.editable);
        assert_eq!(
            selected::scan(&f.root).unwrap_err().kind,
            AuthorityErrorKind::SourceChanged
        );
        assert!(crate::vault::scan::scan_vault(&f.root).is_err());
        assert!(crate::vault::corpus::CorpusCache::new(1)
            .snapshot(&f.root)
            .is_err());
        assert!(crate::read_note(f.root.to_string_lossy().into_owned(), "page.md".into()).is_err());
        assert_eq!(
            crate::set_page_full_width(
                f.root.to_string_lossy().into_owned(),
                "page.md".into(),
                canonical,
                SelectedMode::Default,
            )
            .unwrap_err()
            .kind,
            AuthorityErrorKind::SourceChanged
        );
        assert_eq!(durable_files(&f), before);
        assert_no_publication(&f);
    });
}

#[test]
fn external_neighbors_do_not_relax_the_separate_checked_body_primitive() {
    let f = with_neighbors("external-checked-control", true);
    f.run(|| {
        let _journal = journal(&f, true);
        let before = durable_files(&f);
        assert_eq!(
            replace(&f, &f.version(), AFTER.as_bytes())
                .unwrap_err()
                .kind,
            AuthorityErrorKind::SourceChanged
        );
        assert_eq!(durable_files(&f), before);
        assert_no_publication(&f);
    });
}

#[test]
fn external_neighbors_do_not_block_one_original_human_target_save_or_retain_their_bytes() {
    for target_body in [BEFORE, EXTERNAL, AFTER] {
        let f = with_neighbors("external-neighbors-target-save", true);
        f.run(|| {
            let journal = journal(&f, true);
            fs::write(f.root.join("page.md"), target_body).unwrap();
            let canonical = f.version();
            let before_rows = rows(&f);
            let other_rows: RecordRows = before_rows.iter().filter(|row| row.0 != RECORD).cloned().collect();
            let request = fresh();
            let intent_slot = std::rc::Rc::new(std::cell::RefCell::new(None::<Value>));
            let seen_intent = intent_slot.clone();
            let intent_path = pending(&f);
            let expected_before = target_body.as_bytes().to_vec();
            let result = selected::with_before_install_for_test(
                move || {
                    assert_eq!(fs::read(intent_path.join("before.body")).unwrap(), expected_before);
                    assert_eq!(fs::read(intent_path.join("after.body")).unwrap(), AFTER.as_bytes());
                    *seen_intent.borrow_mut() = Some(
                        serde_json::from_slice(&fs::read(intent_path.join("intent.json")).unwrap()).unwrap(),
                    );
                },
                || command(&f, &journal, AFTER, request.clone()),
            )
            .expect("unrelated ordinary hash drift cannot prevent this admitted human save");
            let crate::NoteSaveResult::Selected(EditorSaveResult::Applied {
                operation, current_version, reconcile_required, recovery,
            }) = result else {
                panic!("target pairing must commit exactly one original operation");
            };
            let intent = intent_slot.borrow().clone().expect("durable original intent was observed");
            assert_eq!(intent["format"], 3);
            assert_eq!(intent["canonical_before_body_hash"], canonical.body_hash);
            assert_eq!(intent["request_key"], request.request_key);
            assert_eq!(intent["operation_id"], operation.operation_id);
            assert_eq!(operation.target, target());
            assert_eq!(operation.path, "page.md");
            assert_eq!(operation.request_key, request.request_key);
            assert_eq!(operation.version, current_version);
            assert!(!reconcile_required);
            let receipt = &operation.receipt;
            assert_eq!(receipt.workspace_id, WORKSPACE);
            assert_eq!(receipt.record_id, RECORD);
            assert_eq!(receipt.epoch, "12");
            assert_eq!(receipt.previous_revision, "7");
            assert_eq!(receipt.revision, "8");
            assert_eq!(receipt.metadata_before_hash, canonical.metadata_hash);
            assert_eq!(receipt.metadata_after_hash, canonical.metadata_hash);
            assert_eq!(receipt.body_before_hash, hash(target_body.as_bytes()));
            assert_eq!(receipt.body_after_hash, hash(AFTER.as_bytes()));
            assert_eq!(receipt.actor, "human:me");
            assert_eq!(receipt.operation, "page.body");
            assert_eq!(receipt.run_id, None);
            assert_eq!(receipt.approved_by, None);
            assert_eq!(intent["receipt"], json!({
                "workspace_id":WORKSPACE,
                "epoch":12,
                "record_id":RECORD,
                "previous_revision":7,
                "revision":8,
                "metadata_before_hash":canonical.metadata_hash,
                "metadata_after_hash":canonical.metadata_hash,
                "body_before_hash":hash(target_body.as_bytes()),
                "body_after_hash":hash(AFTER.as_bytes()),
                "actor":"human:me",
                "run_id":null,
                "approved_by":null,
                "operation":"page.body",
                "at":receipt.at,
            }));
            let persisted: Value = f.conn().query_row(
                "SELECT epoch,record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at,body_before_hash,body_after_hash,run_id,approved_by FROM metadata_receipts",
                [],
                |row| Ok(json!({
                    "workspaceId":WORKSPACE,
                    "epoch":row.get::<_,i64>(0)?.to_string(),
                    "recordId":row.get::<_,String>(1)?,
                    "previousRevision":row.get::<_,i64>(2)?.to_string(),
                    "revision":row.get::<_,i64>(3)?.to_string(),
                    "metadataBeforeHash":row.get::<_,String>(4)?,
                    "metadataAfterHash":row.get::<_,String>(5)?,
                    "actor":row.get::<_,String>(6)?,
                    "operation":row.get::<_,String>(7)?,
                    "at":row.get::<_,String>(8)?,
                    "bodyBeforeHash":row.get::<_,String>(9)?,
                    "bodyAfterHash":row.get::<_,String>(10)?,
                    "runId":row.get::<_,Option<String>>(11)?,
                    "approvedBy":row.get::<_,Option<String>>(12)?,
                })),
            ).unwrap();
            assert_eq!(persisted, serde_json::to_value(receipt.as_ref()).unwrap());
            assert_eq!(receipt_count(&f), 1);
            assert_eq!(state(&f), (12, 5, 8));
            assert_eq!(current_version.metadata_hash, canonical.metadata_hash);
            assert_eq!(current_version.body_hash, hash(AFTER.as_bytes()));
            assert_eq!(metadata_source(&f), before_rows.iter().find(|row| row.0 == RECORD).unwrap().4);
            assert_eq!(rows(&f).into_iter().filter(|row| row.0 != RECORD).collect::<RecordRows>(), other_rows);
            assert_eq!(fs::read(f.root.join("b.md")).unwrap(), EXTERNAL.as_bytes());
            assert_eq!(fs::read(f.root.join("c.md")).unwrap(), EXTERNAL_C.as_bytes());
            assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
            assert!(!pending(&f).exists());
            assert_eq!(count_copies(&f, "pending"), 0);
            if target_body == AFTER {
                assert!(matches!(recovery, Some(Outcome::NotRetained { ref reason }) if reason == "unchanged"));
                assert_eq!(count_copies(&f, "committed"), 0);
            } else {
                assert!(matches!(recovery, Some(Outcome::Retained { .. })));
                assert_eq!(count_copies(&f, "committed"), 1);
                let conn = Connection::open_with_flags(
                    f.origin.join("retained-copies/recovery.sqlite"),
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                ).unwrap();
                let (bytes,before_hash,after_hash,join): (Vec<u8>,String,String,String) = conn.query_row(
                    "SELECT bytes,before_hash,after_hash,selected_join FROM copies WHERE state='committed'", [],
                    |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
                ).unwrap();
                assert_eq!(bytes, target_body.as_bytes());
                assert_eq!(before_hash, receipt.body_before_hash);
                assert_eq!(after_hash, receipt.body_after_hash);
                let join: Value = serde_json::from_str(&join).unwrap();
                assert_eq!(join["workspace_id"], WORKSPACE);
                assert_eq!(join["record_id"], RECORD);
                assert_eq!(join["operation_id"], operation.operation_id);
            }
            // Pairing one record must not stamp B/C to make these reads succeed.
            assert_eq!(selected::scan(&f.root).unwrap_err().kind, AuthorityErrorKind::SourceChanged);
            assert!(crate::vault::corpus::CorpusCache::new(1).snapshot(&f.root).is_err());
            assert!(matches!(
                command(&f, &journal, AFTER, fresh()).unwrap(),
                crate::NoteSaveResult::Selected(EditorSaveResult::Unchanged { .. })
            ));
            assert_eq!(receipt_count(&f), 1);
        });
    }
}

#[test]
fn external_presentation_incomplete_or_unreadable_known_records_remain_unavailable() {
    for damage in [
        "missing_body",
        "invalid_utf8",
        "directory_body",
        "missing_metadata",
        "orphan_body",
    ] {
        let f = with_neighbors("external-unavailable-control", false);
        f.run(|| {
            let journal = journal(&f, true);
            match damage {
                "missing_body" => fs::remove_file(f.root.join("b.md")).unwrap(),
                "invalid_utf8" => fs::write(f.root.join("b.md"), [0xff, 0xfe]).unwrap(),
                "directory_body" => {
                    fs::remove_file(f.root.join("b.md")).unwrap();
                    fs::create_dir(f.root.join("b.md")).unwrap();
                }
                "missing_metadata" => {
                    f.conn()
                        .execute("DELETE FROM records WHERE id=?1", [NEIGHBOR_B])
                        .unwrap();
                }
                "orphan_body" => testutil::write(&f.root, "copied.md", OLD_NEIGHBOR),
                _ => unreachable!(),
            }
            let before = durable_files(&f);
            assert!(
                crate::scan_vault(f.root.to_string_lossy().into_owned()).is_err(),
                "{damage}"
            );
            assert!(
                crate::prepare_selected_open_with_retention(&f.root, Some(&journal)).is_err(),
                "{damage}"
            );
            assert!(command(&f, &journal, AFTER, fresh()).is_err(), "{damage}");
            assert_eq!(durable_files(&f), before, "{damage}");
            assert_no_publication(&f);
        });
    }
}

#[test]
fn external_presentation_changed_workspace_identity_and_wrong_editor_target_never_admit() {
    let f = with_neighbors("external-identity-control", false);
    f.run(|| {
        let journal = journal(&f, true);
        let mut request = fresh();
        request.target.record_id = NEIGHBOR_B.into();
        let before = durable_files(&f);
        let error = command(&f, &journal, AFTER, request).unwrap_err();
        assert_eq!(error["kind"], "selected_refused");
        assert_eq!(error["error"]["kind"], "wrong_identity");
        assert_eq!(durable_files(&f), before);
        assert_no_publication(&f);
        testutil::write(
            &f.root,
            ".cerebro/workspace-format.json",
            &json!({"format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":NEIGHBOR_C}).to_string(),
        );
        let before = durable_files(&f);
        assert!(crate::scan_vault(f.root.to_string_lossy().into_owned()).is_err());
        assert!(crate::list_views(f.root.to_string_lossy().into_owned()).is_err());
        assert!(crate::prepare_selected_open_with_retention(&f.root, Some(&journal)).is_err());
        assert!(command(&f, &journal, AFTER, fresh()).is_err());
        assert_eq!(durable_files(&f), before);
        assert_no_publication(&f);
    });
}

#[test]
fn external_presentation_missing_canonical_store_never_falls_back_or_recreates_it() {
    let f = with_neighbors("external-missing-store-control", false);
    f.run(|| {
        let journal = journal(&f, true);
        fs::remove_file(&f.db).unwrap();
        let before = durable_files(&f);
        assert!(crate::scan_vault(f.root.to_string_lossy().into_owned()).is_err());
        assert!(crate::list_views(f.root.to_string_lossy().into_owned()).is_err());
        assert!(crate::read_editor_body(
            f.root.to_string_lossy().into_owned(),
            "page.md".into(),
            target(),
        )
        .is_err());
        assert!(crate::prepare_selected_open_with_retention(&f.root, Some(&journal)).is_err());
        assert!(command(&f, &journal, AFTER, fresh()).is_err());
        assert_eq!(durable_files(&f), before);
        assert!(
            !f.db.exists(),
            "no read or refused save may recreate canonical metadata"
        );
        // Do not call fixture.conn()/receipt_count here: the test helper itself
        // opens with CREATE. Absence of the entire DB is the receipt assertion.
        assert_eq!(count_copies(&f, "pending"), 0);
        assert_eq!(count_copies(&f, "committed"), 0);
        assert!(!pending(&f).exists());
    });
}

#[test]
fn external_type_dependency_is_not_treated_as_an_unrelated_ordinary_budget_read() {
    let f = with_neighbors("external-type-dependency-control", false);
    f.run(|| {
        let journal = journal(&f, true);
        fs::write(f.root.join("task-type.md"), "# Other type\n").unwrap();
        let before = durable_files(&f);
        let error = command(&f, &journal, AFTER, fresh()).unwrap_err();
        assert_eq!(error["kind"], "selected_refused");
        assert_eq!(error["error"]["kind"], "source_changed");
        assert!(crate::read_editor_body(
            f.root.to_string_lossy().into_owned(),
            "page.md".into(),
            target(),
        )
        .is_err());
        assert!(crate::scan_vault(f.root.to_string_lossy().into_owned()).is_err());
        assert!(crate::prepare_selected_open_with_retention(&f.root, Some(&journal)).is_err());
        assert_eq!(durable_files(&f), before);
        assert_no_publication(&f);
    });
}

#[test]
fn external_presentation_cannot_turn_a_reserved_canonical_record_into_an_editor_target() {
    for reserved in ["Agent", "Type", "Concept", "Skill", "Collection"] {
        let f = with_neighbors("external-protected-control", false);
        f.run(|| {
            let journal = journal(&f, true);
            f.conn().execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![json!({"kind":"object","value":{"type":{"kind":"string","value":reserved}}}).to_string(),RECORD],
            ).unwrap();
            fs::write(f.root.join("page.md"), "# Looks ordinary\n").unwrap();
            let before = durable_files(&f);
            let error = command(&f, &journal, AFTER, fresh()).unwrap_err();
            assert_eq!(error["kind"], "selected_refused");
            assert_eq!(error["error"]["kind"], "unsupported_operation");
            assert_eq!(durable_files(&f), before);
            assert_no_publication(&f);
        });
    }
}

#[test]
fn external_presentation_does_not_resolve_a_pending_original_with_unknown_third_bytes() {
    let f = with_neighbors("external-pending-control", false);
    f.run(|| {
        let journal = journal(&f, true);
        let path = f.root.join("page.md");
        let result = selected::with_before_install_for_test(
            move || fs::write(path, "# Unrecorded third body\n").unwrap(),
            || command(&f, &journal, AFTER, fresh()),
        )
        .unwrap();
        assert!(matches!(
            result,
            crate::NoteSaveResult::Selected(EditorSaveResult::Pending { .. })
        ));
        let before = durable_files(&f);
        let intent = fs::read(pending(&f).join("intent.json")).unwrap();
        assert_eq!(
            authority_error(crate::scan_vault(f.root.to_string_lossy().into_owned()).unwrap_err())
                .kind,
            AuthorityErrorKind::RecoveryRequired
        );
        assert_eq!(
            crate::prepare_selected_open_with_retention(&f.root, Some(&journal))
                .unwrap_err()
                .kind,
            AuthorityErrorKind::RecoveryConflict
        );
        assert_eq!(durable_files(&f), before);
        assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), intent);
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(count_copies(&f, "pending"), 1);
        assert_eq!(count_copies(&f, "committed"), 0);
    });
}

#[test]
fn external_neighbors_aggregate_bound_counts_observed_bytes_before_any_publication() {
    // Root runs this alone / with one test thread: current limits require eight
    // 16 MiB files (128 MiB total), plus the small target and Type declaration.
    // No smaller test-only production cap or duplicated policy is introduced.
    let f = fixture("external-aggregate-control");
    f.run(|| {
        let journal = journal(&f, true);
        let limits = &authority::rules().limits;
        let per_file = usize::try_from(limits.body_bytes).unwrap();
        let aggregate = limits.aggregate_body_bytes;
        assert!(per_file > 0);
        let mut remaining = aggregate;
        let mut index = 0usize;
        while remaining > 0 {
            let size = remaining.min(per_file);
            let path = format!("budget-{index}.md");
            let id = format!("71000000-0000-4000-8000-{index:012x}");
            add_record(&f, &id, &path, OLD_NEIGHBOR, &ordinary_metadata());
            fs::write(f.root.join(path), vec![b'x'; size]).unwrap();
            remaining -= size;
            index += 1;
        }
        let before = durable_files(&f);
        let before_rows = rows(&f);
        let error = command(&f, &journal, AFTER, fresh()).unwrap_err();
        assert_eq!(error["kind"], "selected_refused");
        assert_eq!(
            error["error"]["kind"], "source_limit",
            "budget validation counts actual neighbor bytes without adopting their hashes"
        );
        assert!(crate::scan_vault(f.root.to_string_lossy().into_owned()).is_err());
        assert!(crate::prepare_selected_open_with_retention(&f.root, Some(&journal)).is_err());
        assert_eq!(rows(&f), before_rows);
        assert_eq!(durable_files(&f), before);
        assert_no_publication(&f);
    });
}
