#![cfg(test)]
//! Real temporary-v3 service tests; no staging adoption or active user vault.
use super::*;
use crate::workspace_migration::{cutover, recovery};
use crate::workspace_service::selected::{self, RecoveryReport, SelectedBodyAck};
use std::{
    io::Read,
    process::Stdio,
    time::{Duration, Instant},
};

const TYPE: &str = "61a79a0c-5846-4870-9873-b5382c0d66d0";
const BEFORE: &str = "# Before\r\n";
const AFTER: &str = "\u{feff}---\r\nfull_width: false\r\n---\r\n# After\r\n";

fn fixture(label: &str) -> Fixture {
    let f = Fixture::new(&format!("pair-{label}"));
    // Disposable creation only: never ALTER a selected-v2 store in production.
    fs::remove_file(&f.db).unwrap();
    let conn = Connection::open(&f.db).unwrap();
    conn.execute_batch(include_str!("selected_schema_v3.sql"))
        .unwrap();
    conn.execute("INSERT INTO workspace VALUES (1,2,?1,5,11)", [WORKSPACE])
        .unwrap();
    let source = json!({"kind":"object","value":{
        "type":{"kind":"string","value":"Task"},
        "code":{"kind":"string","value":"007"},
        "full_width":{"kind":"boolean","value":true},
        "present":{"kind":"null"}
    }})
    .to_string();
    conn.execute(
        "INSERT INTO records VALUES (?1,'page.md',7,?2,?3)",
        rusqlite::params![RECORD, crate::ledger::sha256_hex(BEFORE.as_bytes()), source],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO records VALUES (?1,'task-type.md',1,?2,?3)",
        rusqlite::params![
            TYPE,
            crate::ledger::sha256_hex(b"# Task\n"),
            r#"{"kind":"object","value":{"type":{"kind":"string","value":"Type"}}}"#
        ],
    )
    .unwrap();
    drop(conn);
    private_file(&f.db);
    fs::write(f.db.parent().unwrap().join("selected.lock"), []).unwrap();
    private_file(&f.db.parent().unwrap().join("selected.lock"));
    testutil::write(&f.root, "page.md", BEFORE);
    testutil::write(&f.root, "task-type.md", "# Task\n");
    f
}
fn replace(
    f: &Fixture,
    expected: &SelectedRecordVersion,
    body: &[u8],
) -> Result<SelectedBodyAck, AuthorityError> {
    let by = crate::vault::receipt::WriteReceipt::ipc(
        crate::knowledge::guard_human_write("page.md").unwrap(),
    );
    cutover::commit_workspace_change(&f.root, "page.md", expected, body, &by)
}
fn receipt_count(f: &Fixture) -> i64 {
    f.conn()
        .query_row("SELECT count(*) FROM metadata_receipts", [], |r| r.get(0))
        .unwrap()
}
fn metadata_source(f: &Fixture) -> String {
    f.conn()
        .query_row("SELECT metadata FROM records WHERE id=?1", [RECORD], |r| {
            r.get(0)
        })
        .unwrap()
}
fn state(f: &Fixture) -> (i64, i64, i64) {
    f.conn().query_row("SELECT metadata_epoch,schema_revision,(SELECT revision FROM records WHERE id=?1) FROM workspace", [RECORD], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
}

#[test]
fn actual_body_replace_preserves_exact_metadata_and_returns_one_paired_revision() {
    let f = fixture("normal");
    let metadata = f.stored();
    let exact_metadata = metadata_source(&f);
    f.run(|| {
        let ack = replace(&f, &f.version(), AFTER.as_bytes()).unwrap();
        assert!(matches!(ack, SelectedBodyAck::Applied { ref epoch, .. } if epoch == "12"));
        assert_eq!(state(&f), (12,5,8));
        assert_eq!(f.stored(), metadata);
        assert_eq!(metadata_source(&f),exact_metadata);
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        let entries = crate::scan_vault(f.root.to_str().unwrap().into()).unwrap();
        let entry = entries.iter().find(|r| r.path == "page.md").unwrap();
        assert_eq!(entry.properties["full_width"], true);
        assert_eq!(entry.entry_type.as_deref(), Some("Task"));
        let receipt: (String,String,String,String,Option<String>,Option<String>) = f.conn().query_row(
            "SELECT actor,operation,body_before_hash,body_after_hash,run_id,approved_by FROM metadata_receipts", [],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
        assert_eq!(receipt, ("human:me".into(),"page.body".into(),crate::ledger::sha256_hex(BEFORE.as_bytes()),crate::ledger::sha256_hex(AFTER.as_bytes()),None,None));
        assert_eq!(recovery::recover_workspace(&f.root).unwrap(), RecoveryReport::Clean);
    });
}

#[test]
fn changed_body_after_sql_commit_preserves_pending_evidence_and_refuses_ack() {
    let f = fixture("postcommit-external");
    let target = f.root.join("page.md");
    f.run(|| {
        let result = selected::with_after_commit_for_test(
            move || fs::write(target, b"# Outside after commit\n").unwrap(),
            || replace(&f, &f.version(), AFTER.as_bytes()),
        );
        assert_eq!(
            result.unwrap_err().kind,
            AuthorityErrorKind::RecoveryConflict
        );
        assert_eq!(
            fs::read(f.root.join("page.md")).unwrap(),
            b"# Outside after commit\n"
        );
        assert!(f
            .db
            .parent()
            .unwrap()
            .join("pending-change/intent.json")
            .exists());
        assert_eq!(state(&f), (12, 5, 8));
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(
            recovery::recover_workspace(&f.root).unwrap_err().kind,
            AuthorityErrorKind::RecoveryConflict
        );
    });
}

#[test]
fn exact_postimage_written_externally_before_install_is_not_adopted_as_a_human_write() {
    let f = fixture("preinstall-external");
    let target = f.root.join("page.md");
    f.run(|| {
        let result = selected::with_before_install_for_test(
            move || fs::write(target, AFTER.as_bytes()).unwrap(),
            || replace(&f, &f.version(), AFTER.as_bytes()),
        );
        assert_eq!(
            result.unwrap_err().kind,
            AuthorityErrorKind::RecoveryConflict
        );
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), AFTER.as_bytes());
        assert!(f
            .db
            .parent()
            .unwrap()
            .join("pending-change/intent.json")
            .exists());
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
    });
}

#[test]
fn replacing_the_newly_written_temp_never_installs_foreign_bytes() {
    let f = fixture("temp-written-substitute");
    let saved = f.origin.join("owned-temp-before-substitution");
    let changed = std::rc::Rc::new(std::cell::RefCell::new(None::<PathBuf>));
    let capture = changed.clone();
    f.run(|| {
        let result = selected::with_journal_path_hook(
            "temp_written",
            move |path| {
                fs::rename(path, &saved).unwrap();
                fs::write(path, b"# Foreign staging inode\n").unwrap();
                private_file(path);
                *capture.borrow_mut() = Some(path.to_owned());
            },
            || replace(&f, &f.version(), AFTER.as_bytes()),
        );
        assert_eq!(
            result.unwrap_err().kind,
            AuthorityErrorKind::RecoveryConflict
        );
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        assert_eq!(
            fs::read(changed.borrow().as_ref().unwrap()).unwrap(),
            b"# Foreign staging inode\n"
        );
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert!(f
            .db
            .parent()
            .unwrap()
            .join("pending-change/intent.json")
            .exists());
    });
}

#[test]
fn replacing_a_validated_complete_temp_does_not_authorize_deleting_the_replacement() {
    let f = fixture("temp-read-substitute");
    stopped(&f, "selected-body-temp-durable", false);
    let saved = f.origin.join("validated-temp-before-substitution");
    let changed = std::rc::Rc::new(std::cell::RefCell::new(None::<PathBuf>));
    let capture = changed.clone();
    f.run(|| {
        let result = selected::with_journal_path_hook(
            "temp_read",
            move |path| {
                fs::rename(path, &saved).unwrap();
                fs::write(path, b"# Foreign recovery inode\n").unwrap();
                private_file(path);
                *capture.borrow_mut() = Some(path.to_owned());
            },
            || recovery::recover_workspace(&f.root),
        );
        assert_eq!(
            result.unwrap_err().kind,
            AuthorityErrorKind::RecoveryConflict
        );
        assert_eq!(
            fs::read(changed.borrow().as_ref().unwrap()).unwrap(),
            b"# Foreign recovery inode\n"
        );
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        assert_eq!(state(&f), (11, 5, 7));
        assert!(f
            .db
            .parent()
            .unwrap()
            .join("pending-change/intent.json")
            .exists());
    });
}

#[test]
fn retired_cleanup_never_deletes_an_inode_substituted_after_its_byte_validation() {
    let f = fixture("retired-read-substitute");
    let saved = f.origin.join("validated-retired-before-substitution");
    let changed = std::rc::Rc::new(std::cell::RefCell::new(None::<PathBuf>));
    let capture = changed.clone();
    f.run(|| {
        let result = selected::with_journal_path_hook(
            "retired_read",
            move |path| {
                fs::rename(path, &saved).unwrap();
                fs::write(path, b"foreign retained evidence").unwrap();
                private_file(path);
                *capture.borrow_mut() = Some(path.to_owned());
            },
            || replace(&f, &f.version(), AFTER.as_bytes()),
        );
        assert!(matches!(result.unwrap(), SelectedBodyAck::Applied { .. }));
        assert_eq!(
            fs::read(changed.borrow().as_ref().unwrap()).unwrap(),
            b"foreign retained evidence"
        );
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), AFTER.as_bytes());
        assert_eq!(state(&f), (12, 5, 8));
        assert_eq!(receipt_count(&f), 1);
        assert!(!f.db.parent().unwrap().join("pending-change").exists());
    });
}

#[test]
fn identical_body_and_stale_expectations_do_not_publish() {
    let f = fixture("noop-stale");
    f.run(|| {
        let original = f.version();
        assert!(matches!(
            replace(&f, &original, BEFORE.as_bytes()).unwrap(),
            SelectedBodyAck::Unchanged { .. }
        ));
        for which in 0..5 {
            let mut expected = original.clone();
            match which {
                0 => expected.workspace_id = TYPE.into(),
                1 => expected.record_id = TYPE.into(),
                2 => expected.metadata_revision = "6".into(),
                3 => expected.metadata_hash = "0".repeat(64),
                _ => expected.body_hash = "0".repeat(64),
            }
            assert!(replace(&f, &expected, AFTER.as_bytes()).is_err());
        }
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert!(!f.db.parent().unwrap().join("pending-change").exists());
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
    });
}

#[test]
fn exact_unprojectable_metadata_survives_and_unknown_governed_types_refuse() {
    let f = fixture("exact-types");
    let mut metadata = f.stored();
    metadata["value"]["large"] = json!({"kind":"decimal","value":"1e400"});
    metadata["value"]["relation"] = json!({"kind":"relation","spelling":"[[Task]]","fragment":null,"resolution":{"status":"resolved","targetId":TYPE}});
    f.conn()
        .execute(
            "UPDATE records SET metadata=?1 WHERE id=?2",
            rusqlite::params![metadata.to_string(), RECORD],
        )
        .unwrap();
    let exact_metadata = metadata_source(&f);
    f.run(|| {
        replace(&f, &f.version(), AFTER.as_bytes()).unwrap();
        assert_eq!(f.stored(), metadata);
        assert_eq!(metadata_source(&f), exact_metadata);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        assert_eq!(
            selected::scan(&f.root).unwrap_err().kind,
            AuthorityErrorKind::UnsupportedProjection
        );
        for kind in [
            "Agent",
            "Concept",
            "Type",
            "Skill",
            "Collection",
            "Unknown",
            " aGeNt ",
        ] {
            metadata["value"]["type"] = json!({"kind":"string","value":kind});
            f.conn()
                .execute(
                    "UPDATE records SET metadata=?1 WHERE id=?2",
                    rusqlite::params![metadata.to_string(), RECORD],
                )
                .unwrap();
            assert_eq!(
                replace(&f, &f.version(), BEFORE.as_bytes())
                    .unwrap_err()
                    .kind,
                AuthorityErrorKind::UnsupportedOperation
            );
        }
        assert_eq!(receipt_count(&f), 1);
    });
}

#[test]
fn v2_body_refusal_and_missing_v3_lock_never_create_or_upgrade() {
    let f = Fixture::new("pair-v2");
    f.run(|| {
        let before = fs::read(&f.db).unwrap();
        assert_eq!(
            replace(&f, &f.version(), AFTER.as_bytes())
                .unwrap_err()
                .kind,
            AuthorityErrorKind::UnsupportedFormat
        );
        assert_eq!(fs::read(&f.db).unwrap(), before);
        assert!(!f.db.parent().unwrap().join("selected.lock").exists());
    });
    let f = fixture("missing-lock");
    let lock = f.db.parent().unwrap().join("selected.lock");
    fs::remove_file(&lock).unwrap();
    f.run(|| {
        assert!(selected::read_body(&f.root, "page.md").is_err());
        assert!(recovery::recover_workspace(&f.root).is_err());
        assert!(!lock.exists());
    });
}

#[test]
fn lock_contention_and_private_lock_identity_fail_without_mutation() {
    use std::os::unix::fs::symlink;
    let f = fixture("lock-contention");
    let path = f.db.parent().unwrap().join("selected.lock");
    let held = fs::File::options()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    held.try_lock().unwrap();
    f.run(|| {
        assert_eq!(
            selected::read_body(&f.root, "page.md").unwrap_err().kind,
            AuthorityErrorKind::Busy
        );
        assert_eq!(
            replace(&f, &f.version(), AFTER.as_bytes())
                .unwrap_err()
                .kind,
            AuthorityErrorKind::Busy
        );
    });
    drop(held);
    fs::remove_file(&path).unwrap();
    symlink(&f.db, &path).unwrap();
    let database = fs::read(&f.db).unwrap();
    f.run(|| assert!(selected::read_body(&f.root, "page.md").is_err()));
    assert_eq!(fs::read(&f.db).unwrap(), database);
    assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
}

#[test]
fn actual_sqlite_handle_rejects_preopen_symlink_and_substitute_then_restore() {
    use std::os::unix::fs::symlink;
    for symlink_case in [true, false] {
        let f = Fixture::new(if symlink_case {
            "pair-db-symlink"
        } else {
            "pair-db-handle"
        });
        let db = f.db.clone();
        let saved = db.with_extension("original");
        let db_after = db.clone();
        let saved_after = saved.clone();
        let after = (!symlink_case).then(|| {
            Box::new(move || {
                fs::remove_file(&db_after).unwrap();
                fs::rename(&saved_after, &db_after).unwrap();
            }) as Box<dyn FnOnce()>
        });
        f.run(|| {
            let result = selected::with_open_hooks(
                Some(Box::new(move || {
                    fs::rename(&db, &saved).unwrap();
                    if symlink_case {
                        symlink(&saved, &db).unwrap();
                    } else {
                        fs::copy(&saved, &db).unwrap();
                        private_file(&db);
                    }
                })),
                after,
                || selected::read_body(&f.root, "page.md"),
            );
            assert!(result.is_err());
        });
        if symlink_case {
            fs::remove_file(&f.db).unwrap();
            fs::rename(f.db.with_extension("original"), &f.db).unwrap();
        }
        f.run(|| assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), BODY));
    }
}

#[test]
fn artifact_pressure_and_overlarge_body_leave_logical_rows_and_evidence_unchanged() {
    let f = fixture("pressure");
    let directory = f.db.parent().unwrap();
    let mut evidence = Vec::new();
    for n in 1..=3 {
        let path = directory.join(format!(".prepare-70000000-0000-4000-8000-{n:012x}"));
        fs::create_dir(&path).unwrap();
        private_dir(&path);
        for (name, bytes) in [
            ("intent.json", b"{}".as_slice()),
            ("before.body", b"before".as_slice()),
            ("after.body", b"after".as_slice()),
        ] {
            let part = path.join(name);
            fs::write(&part, bytes).unwrap();
            private_file(&part);
            evidence.push((part, bytes.to_vec()));
        }
    }
    let version = f.version();
    f.run(|| {
        assert_eq!(
            replace(&f, &version, AFTER.as_bytes()).unwrap_err().kind,
            AuthorityErrorKind::ArtifactPressure
        );
        assert_eq!(
            replace(&f, &version, &vec![b'a'; 16 * 1024 * 1024 + 1])
                .unwrap_err()
                .kind,
            AuthorityErrorKind::SourceLimit
        );
    });
    assert_eq!(f.version(), version);
    assert_eq!(state(&f), (11, 5, 7));
    assert_eq!(receipt_count(&f), 0);
    assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
    for (part, bytes) in evidence {
        assert_eq!(fs::read(part).unwrap(), bytes);
    }
    assert!(!directory.join("pending-change").exists());
}

#[test]
fn v3_full_width_and_nested_views_share_the_protocol_without_deadlock() {
    let f = fixture("width-views");
    f.run(|| {
        assert!(selected::views(&f.root).unwrap().is_empty());
        mutate(&f, f.version(), SelectedMode::Default).unwrap();
        let (before, after, operation): (String, String, String) = f
            .conn()
            .query_row(
                "SELECT body_before_hash,body_after_hash,operation FROM metadata_receipts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(before, crate::ledger::sha256_hex(BEFORE.as_bytes()));
        assert_eq!(operation, "page.full_width");
        replace(&f, &f.version(), AFTER.as_bytes()).unwrap();
        assert_eq!(receipt_count(&f), 2);
    });
}

// Own a finite child and file-backed output: a wedged pipe cannot prevent the
// deadline. Kill only this child on timeout; never abort the parent or provider.
fn stopped(f: &Fixture, point: &str, recover: bool) {
    let output = f.origin.join("child-output.txt");
    let file = fs::File::create(&output).unwrap();
    let mut child = crate::spawn::command(std::env::current_exe().unwrap())
        .args([
            "workspace_service::selected_tests::paired::paired_stop_child",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_remove("CEREBRO_CRASH_POINT")
        .env("CEREBRO_STOP_POINT", point)
        .env("CEREBRO_PAIR_ROOT", &f.root)
        .env("CEREBRO_PAIR_ORIGIN", &f.origin)
        .env("CEREBRO_PAIR_RECOVER", if recover { "1" } else { "0" })
        .stdout(Stdio::from(file.try_clone().unwrap()))
        .stderr(Stdio::from(file))
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned paired child exceeded its deadline at {point}");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut text = String::new();
    fs::File::open(output)
        .unwrap()
        .take(65536)
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(status.code(), Some(86), "child missed {point}: {text}");
}

#[test]
fn paired_stop_child() {
    let Ok(root) = std::env::var("CEREBRO_PAIR_ROOT") else {
        return;
    };
    let origin = PathBuf::from(std::env::var("CEREBRO_PAIR_ORIGIN").unwrap());
    let root = PathBuf::from(root);
    for path in [&root, &origin] {
        assert!(path
            .canonicalize()
            .unwrap()
            .starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert!(path.file_name().unwrap().to_string_lossy().contains("m99-"));
    }
    let db = origin
        .join("workspaces")
        .join(WORKSPACE)
        .join("workspace.db");
    let f = std::mem::ManuallyDrop::new(Fixture { root, origin, db });
    f.run(|| {
        if std::env::var("CEREBRO_PAIR_RECOVER").as_deref() == Ok("1") {
            recovery::recover_workspace(&f.root).unwrap();
        } else {
            replace(&f, &f.version(), AFTER.as_bytes()).unwrap();
        }
    });
}

#[test]
fn every_durable_boundary_reopens_to_only_the_original_or_committed_pair() {
    for point in [
        "selected-journal-durable",
        "selected-body-temp-durable",
        "selected-body-renamed",
        "selected-body-directory-synced",
        "selected-receipt-staged",
        "selected-metadata-committed",
        "selected-workspace-published",
    ] {
        let f = fixture(point);
        let expected = f.version();
        stopped(&f, point, false);
        f.run(|| {
            let committed = matches!(
                point,
                "selected-metadata-committed" | "selected-workspace-published"
            );
            if point != "selected-workspace-published" {
                assert_eq!(
                    selected::read_body(&f.root, "page.md").unwrap_err().kind,
                    AuthorityErrorKind::RecoveryRequired
                );
                assert_eq!(
                    mutate(&f, expected.clone(), SelectedMode::Default)
                        .unwrap_err()
                        .kind,
                    AuthorityErrorKind::RecoveryRequired
                );
            }
            let result = recovery::recover_workspace(&f.root).unwrap();
            assert!(if committed {
                matches!(
                    result,
                    RecoveryReport::Completed { .. } | RecoveryReport::Clean
                )
            } else {
                matches!(result, RecoveryReport::RolledBack { .. })
            });
            assert_eq!(
                selected::read_body(&f.root, "page.md").unwrap(),
                if committed { AFTER } else { BEFORE }
            );
            assert_eq!(state(&f), if committed { (12, 5, 8) } else { (11, 5, 7) });
            assert_eq!(receipt_count(&f), i64::from(committed));
            assert_eq!(
                recovery::recover_workspace(&f.root).unwrap(),
                RecoveryReport::Clean
            );
            if committed {
                assert!(replace(&f, &expected, AFTER.as_bytes()).is_err());
                assert_eq!(receipt_count(&f), 1);
            }
        });
    }
}

#[test]
fn third_party_missing_corrupt_and_partial_temp_evidence_is_never_overwritten() {
    for change in ["third-party", "missing", "part", "temp", "receipt"] {
        let f = fixture(change);
        stopped(
            &f,
            if change == "receipt" {
                "selected-metadata-committed"
            } else {
                "selected-body-renamed"
            },
            false,
        );
        let pending = f.db.parent().unwrap().join("pending-change");
        let intent: Value =
            serde_json::from_slice(&fs::read(pending.join("intent.json")).unwrap()).unwrap();
        match change {
            "third-party" => fs::write(f.root.join("page.md"), b"# Outside\n").unwrap(),
            "missing" => fs::remove_file(f.root.join("page.md")).unwrap(),
            "part" => fs::write(pending.join("before.body"), b"short").unwrap(),
            "temp" => {
                let path = f.root.join(format!(
                    ".cerebro-pair-{}.pending-body",
                    intent["operation_id"].as_str().unwrap()
                ));
                fs::write(&path, b"partial").unwrap();
                private_file(&path);
            }
            _ => {
                f.conn()
                    .execute(
                        "UPDATE metadata_receipts SET body_after_hash=?1",
                        ["0".repeat(64)],
                    )
                    .unwrap();
            }
        }
        let body = fs::read(f.root.join("page.md")).ok();
        let database = fs::read(&f.db).unwrap();
        let envelope = fs::read(pending.join("intent.json")).unwrap();
        f.run(|| {
            for _ in 0..2 {
                assert_eq!(
                    recovery::recover_workspace(&f.root).unwrap_err().kind,
                    AuthorityErrorKind::RecoveryConflict
                );
            }
        });
        assert_eq!(fs::read(f.root.join("page.md")).ok(), body);
        assert_eq!(fs::read(&f.db).unwrap(), database);
        assert_eq!(fs::read(pending.join("intent.json")).unwrap(), envelope);
    }
}

#[test]
fn recovery_reentry_at_its_own_rename_and_retirement_boundaries_is_idempotent() {
    for (point, committed) in [
        ("selected-recovery-old-renamed", false),
        ("selected-recovery-new-renamed", true),
        ("selected-workspace-published", true),
    ] {
        let f = fixture(point);
        stopped(
            &f,
            if committed {
                "selected-metadata-committed"
            } else {
                "selected-body-renamed"
            },
            false,
        );
        if committed && point == "selected-recovery-new-renamed" {
            fs::write(f.root.join("page.md"), BEFORE).unwrap();
        }
        stopped(&f, point, true);
        f.run(|| {
            recovery::recover_workspace(&f.root).unwrap();
            assert_eq!(
                recovery::recover_workspace(&f.root).unwrap(),
                RecoveryReport::Clean
            );
            assert_eq!(
                selected::read_body(&f.root, "page.md").unwrap(),
                if committed { AFTER } else { BEFORE }
            );
            assert_eq!(receipt_count(&f), i64::from(committed));
        });
    }
}

#[test]
fn startup_v2_existing_lock_and_dangling_pending_remain_version_specific() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new("startup-v2-lock");
    let lock = f.db.parent().unwrap().join("selected.lock");
    fs::write(&lock, []).unwrap();
    private_file(&lock);
    let database = fs::read(&f.db).unwrap();
    f.run(|| {
        assert_eq!(
            recovery::recover_workspace(&f.root).unwrap(),
            RecoveryReport::Clean
        )
    });
    assert_eq!(fs::read(&f.db).unwrap(), database);
    let pending = f.db.parent().unwrap().join("pending-change");
    let missing = f.origin.join("no-such-evidence");
    symlink(&missing, &pending).unwrap();
    f.run(|| {
        assert_eq!(
            recovery::recover_workspace(&f.root).unwrap_err().kind,
            AuthorityErrorKind::RecoveryRequired
        );
        assert!(crate::prepare_selected_open(&f.root).is_err());
    });
    assert_eq!(fs::read_link(&pending).unwrap(), missing);
    assert!(!missing.exists());
    assert_eq!(fs::read(&f.db).unwrap(), database);
    assert_eq!(fs::read(&lock).unwrap(), b"");
}

#[test]
fn startup_recovery_rechecks_v2_and_v3_binding_after_opening_sqlite() {
    for paired in [false, true] {
        let f = if paired {
            fixture("startup-stale-v3")
        } else {
            Fixture::new("startup-stale-v2")
        };
        let marker = f.root.join(".cerebro/workspace-format.json");
        let original_marker = fs::read(&marker).unwrap();
        let mut changed: Value = serde_json::from_slice(&original_marker).unwrap();
        changed["workspaceId"] = json!(RECORD);
        let database = fs::read(&f.db).unwrap();
        f.run(|| {
            let result = selected::with_open_hooks(
                None,
                Some(Box::new(move || {
                    fs::write(marker, changed.to_string()).unwrap()
                })),
                || recovery::recover_workspace(&f.root),
            );
            assert_eq!(result.unwrap_err().kind, AuthorityErrorKind::WrongIdentity);
        });
        assert_eq!(fs::read(&f.db).unwrap(), database);
        assert_eq!(
            fs::read(f.root.join("page.md")).unwrap(),
            if paired {
                BEFORE.as_bytes()
            } else {
                BODY.as_bytes()
            }
        );
        fs::write(
            f.root.join(".cerebro/workspace-format.json"),
            original_marker,
        )
        .unwrap();
    }
}

#[test]
fn startup_selected_opener_refuses_missing_lock_and_busy_without_mutation() {
    for missing in [false, true] {
        let f = fixture("startup-lock");
        let lock = f.db.parent().unwrap().join("selected.lock");
        let database = fs::read(&f.db).unwrap();
        let held = if missing {
            fs::remove_file(&lock).unwrap();
            None
        } else {
            let file = fs::File::options()
                .read(true)
                .write(true)
                .open(&lock)
                .unwrap();
            file.try_lock().unwrap();
            Some(file)
        };
        f.run(|| {
            let expected = if missing {
                AuthorityErrorKind::MetadataUnavailable
            } else {
                AuthorityErrorKind::Busy
            };
            assert_eq!(
                recovery::recover_workspace(&f.root).unwrap_err().kind,
                expected
            );
            assert_eq!(
                crate::prepare_selected_open(&f.root).unwrap_err().kind,
                expected
            );
        });
        assert_eq!(fs::read(&f.db).unwrap(), database);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        assert_eq!(lock.exists(), !missing);
        drop(held);
    }
}

#[test]
fn startup_selected_opener_recovers_old_and_new_before_its_actual_scan() {
    for committed in [false, true] {
        let f = fixture("startup-paired-decision");
        let metadata = metadata_source(&f);
        stopped(
            &f,
            if committed {
                "selected-metadata-committed"
            } else {
                "selected-body-renamed"
            },
            false,
        );
        let pending = f.db.parent().unwrap().join("pending-change");
        f.run(|| {
            // This is the exact step start_watcher calls after suspension and
            // before watcher startup/publication, not a test-side reconstruction.
            assert_eq!(
                selected::scan(&f.root).unwrap_err().kind,
                AuthorityErrorKind::RecoveryRequired
            );
            crate::prepare_selected_open(&f.root).unwrap();
            assert_eq!(
                selected::read_body(&f.root, "page.md").unwrap(),
                if committed { AFTER } else { BEFORE }
            );
            assert_eq!(metadata_source(&f), metadata);
            assert_eq!(state(&f), if committed { (12, 5, 8) } else { (11, 5, 7) });
            assert_eq!(receipt_count(&f), i64::from(committed));
            assert!(!pending.exists());
            crate::prepare_selected_open(&f.root).unwrap();
            assert_eq!(receipt_count(&f), i64::from(committed));
        });
    }
}

#[test]
fn startup_selected_opener_retains_conflicting_body_and_pending_evidence() {
    let f = fixture("startup-conflict");
    stopped(&f, "selected-body-renamed", false);
    fs::write(
        f.root.join("page.md"),
        b"# Third party after interruption\n",
    )
    .unwrap();
    let pending = f.db.parent().unwrap().join("pending-change");
    let parts: Vec<_> = ["intent.json", "before.body", "after.body"]
        .into_iter()
        .map(|name| (pending.join(name), fs::read(pending.join(name)).unwrap()))
        .collect();
    f.run(|| {
        assert_eq!(
            crate::prepare_selected_open(&f.root).unwrap_err().kind,
            AuthorityErrorKind::RecoveryConflict
        );
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        for (path, bytes) in &parts {
            assert_eq!(fs::read(path).unwrap(), *bytes);
        }
        assert_eq!(
            fs::read(f.root.join("page.md")).unwrap(),
            b"# Third party after interruption\n"
        );
        assert_eq!(
            selected::scan(&f.root).unwrap_err().kind,
            AuthorityErrorKind::RecoveryRequired
        );
    });
}

#[test]
fn startup_recovery_does_not_publish_a_superseded_opening_or_enable_runs() {
    let f = fixture("startup-generation");
    stopped(&f, "selected-body-renamed", false);
    f.run(|| {
        let context = authority::context().unwrap();
        let agents = crate::agent::AgentState::default();
        let first = context.begin_open().unwrap();
        agents.begin_open(first).unwrap();
        crate::prepare_selected_open(&f.root).unwrap();
        let later = context.begin_open().unwrap();
        agents.begin_open(later).unwrap();
        assert_eq!(
            context.publish_open(first, &f.root).unwrap_err().kind,
            AuthorityErrorKind::SourceChanged
        );
        assert_eq!(context.active_root().unwrap(), None);
        assert!(agents.prepare_run(&f.root).is_err());
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), BEFORE);
        assert_eq!(receipt_count(&f), 0);
    });
}

fn pending_retention(f: &Fixture) -> (crate::vault::recovery::Journal, PathBuf, String) {
    let root = f.origin.join("recovery");
    let journal = crate::vault::recovery::Journal::open(&root).unwrap();
    journal.set_enabled(&f.root, true).unwrap();
    let workspace = fs::File::options()
        .read(true)
        .write(true)
        .open(f.db.parent().unwrap().join("selected.lock"))
        .unwrap();
    workspace.try_lock().unwrap();
    let path = crate::vault::write::lock_selected_path(&f.root, "page.md").unwrap();
    let id = crate::vault::recovery::prepare_selected_sweep_fixture(
        &journal, &path, &f.root, "page.md", BEFORE, AFTER,
    )
    .unwrap();
    drop(path);
    drop(workspace);
    (journal, root, id)
}

fn pending_retention_row(root: &Path, id: &str) -> Option<(String, Vec<u8>)> {
    use rusqlite::OptionalExtension;
    let conn = Connection::open_with_flags(
        root.join("recovery.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    conn.query_row("SELECT state,bytes FROM copies WHERE id=?1", [id], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .optional()
    .unwrap()
}

fn assert_sweep_does_not_decide_an_unrecovered_pair(reopen: bool) {
    for point in [
        "selected-journal-durable",
        "selected-body-renamed",
        "selected-metadata-committed",
    ] {
        let f = fixture("selected-retention-sweep");
        let (journal, retained_root, id) = f.run(|| pending_retention(&f));
        stopped(&f, point, false);
        let visible = fs::read(f.root.join("page.md")).unwrap();
        let pending = f.db.parent().unwrap().join("pending-change");
        let parts: Vec<_> = ["intent.json", "before.body", "after.body"]
            .into_iter()
            .map(|name| (pending.join(name), fs::read(pending.join(name)).unwrap()))
            .collect();
        f.run(|| {
            let journal = if reopen {
                drop(journal);
                crate::vault::recovery::Journal::open(&retained_root).unwrap()
            } else {
                journal.status(&f.root).unwrap();
                journal.list(&f.root, "page.md").unwrap();
                journal
            };
            assert_eq!(pending_retention_row(&retained_root, &id),
                Some(("pending".into(), BEFORE.as_bytes().to_vec())),
                "M93 cleanup decided a copy while the original paired intent was unresolved at {point}");
            assert_eq!(fs::read(f.root.join("page.md")).unwrap(), visible);
            for (path, bytes) in &parts { assert_eq!(fs::read(path).unwrap(), *bytes); }
            let committed = point == "selected-metadata-committed";
            let outcome = recovery::recover_workspace(&f.root).unwrap();
            assert!(if committed { matches!(outcome, RecoveryReport::Completed { .. }) }
                else { matches!(outcome, RecoveryReport::RolledBack { .. }) });
            journal.sweep_all().unwrap();
            // Schema1 has no original selected-operation identity. Even after
            // paired recovery, current path/hash is not a proven capture join.
            assert_eq!(pending_retention_row(&retained_root, &id),
                Some(("pending".into(), BEFORE.as_bytes().to_vec())));
            assert_eq!(receipt_count(&f), i64::from(committed));
            assert_eq!(selected::read_body(&f.root, "page.md").unwrap(),
                if committed { AFTER } else { BEFORE });
            drop(journal);
        });
    }
}

#[test]
fn selected_retention_setup_sweep_waits_for_the_original_paired_decision() {
    assert_sweep_does_not_decide_an_unrecovered_pair(true);
}

#[test]
fn selected_retention_access_sweeps_wait_for_the_original_paired_decision() {
    assert_sweep_does_not_decide_an_unrecovered_pair(false);
}

#[test]
fn selected_retention_invalid_binding_never_falls_back_to_visible_hash() {
    let f = fixture("retention-invalid-binding");
    let (journal, retained_root, id) = f.run(|| pending_retention(&f));
    f.run(|| {
        replace(&f, &f.version(), AFTER.as_bytes()).unwrap();
        fs::write(
            f.origin.join("workspaces/bindings.v1.json"),
            b"malformed trusted registry",
        )
        .unwrap();
        journal.status(&f.root).unwrap();
        assert_eq!(
            pending_retention_row(&retained_root, &id),
            Some(("pending".into(), BEFORE.as_bytes().to_vec()))
        );
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), AFTER.as_bytes());
        assert_eq!(receipt_count(&f), 1);
    });
    drop(journal);
}

#[test]
fn selected_retention_unjoined_rows_do_not_acquire_the_recorded_path_lock() {
    let f = fixture("retention-no-path-wait");
    let (journal, retained_root, id) = f.run(|| pending_retention(&f));
    f.run(|| {
        let held = crate::vault::write::lock_selected_path(&f.root, "page.md").unwrap();
        // Existing path locks refuse recursive acquisition, making this causal
        // without a timing assertion or a worker that can outlive its fixture.
        let status = journal.status(&f.root).unwrap();
        assert_eq!(status.pending, 1);
        assert_eq!(
            pending_retention_row(&retained_root, &id),
            Some(("pending".into(), BEFORE.as_bytes().to_vec()))
        );
        drop(held);
    });
    drop(journal);
}

#[path = "selected_retention_tests.rs"]
mod retained;

#[path = "selected_editor_tests.rs"]
mod editor;

#[test]
fn cold_open_scan_command_preserves_pending_evidence_and_serializes_the_recovery_hint() {
    for committed in [false, true] {
        let f = fixture("cold-open-scan-command");
        stopped(
            &f,
            if committed {
                "selected-metadata-committed"
            } else {
                "selected-body-renamed"
            },
            false,
        );
        let pending = f.db.parent().unwrap().join("pending-change");
        let database = fs::read(&f.db).unwrap();
        let body = fs::read(f.root.join("page.md")).unwrap();
        let evidence: Vec<_> = ["intent.json", "before.body", "after.body"]
            .into_iter()
            .map(|name| (pending.join(name), fs::read(pending.join(name)).unwrap()))
            .collect();
        f.run(|| {
            // Exercise the actual Tauri command's error envelope. The frontend
            // may use this refusal to reach startup, never to authorize recovery.
            let refusal = crate::scan_vault(f.root.to_str().unwrap().into()).unwrap_err();
            assert_eq!(
                serde_json::to_value(refusal).unwrap(),
                json!({
                    "code": "capability_unavailable",
                    "kind": "recovery_required",
                    "message": "This workspace has an unfinished paired change.",
                    "retryable": false
                })
            );
            assert_eq!(fs::read(&f.db).unwrap(), database);
            assert_eq!(fs::read(f.root.join("page.md")).unwrap(), body);
            for (path, bytes) in &evidence {
                assert_eq!(fs::read(path).unwrap(), *bytes);
            }

            // The existing startup owner remains the only recovery consumer.
            crate::prepare_selected_open(&f.root).unwrap();
            let entries = crate::scan_vault(f.root.to_str().unwrap().into()).unwrap();
            let page = entries
                .iter()
                .find(|entry| entry.path == "page.md")
                .unwrap();
            assert_eq!(page.title, if committed { "After" } else { "Before" });
            assert_eq!(page.properties["full_width"], true);
            assert_eq!(state(&f), if committed { (12, 5, 8) } else { (11, 5, 7) });
            assert_eq!(receipt_count(&f), i64::from(committed));
            assert!(!pending.exists());
        });
    }
}

// These fixtures require successful live export through the macOS scoped VFS.
#[cfg(target_os = "macos")]
#[path = "portable_backup_tests.rs"]
mod portable_backup;
