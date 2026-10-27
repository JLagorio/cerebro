#![cfg(test)]
//! Same protected native facade in RED and GREEN. RED is missing functionality:
//! the original RED facade was deliberately closed, not an old-CAS regression.
use super::*;
use crate::vault::recovery::{Journal, Outcome};
use crate::workspace_service::selected::{ProtectedBodyAck, ProtectedBodyError};

fn journal(f: &Fixture) -> (Journal, PathBuf) {
    let root = f.origin.join("retained-copies");
    let journal = Journal::open(&root).unwrap();
    journal.set_enabled(&f.root, true).unwrap();
    (journal, root)
}
fn protected(
    f: &Fixture,
    journal: &Journal,
    expected: &SelectedRecordVersion,
    bypass: Option<&str>,
) -> Result<ProtectedBodyAck, ProtectedBodyError> {
    let by = crate::vault::receipt::WriteReceipt::ipc(
        crate::knowledge::guard_human_write("page.md").unwrap(),
    );
    cutover::commit_workspace_change_with_recovery(
        &f.root,
        "page.md",
        expected,
        AFTER.as_bytes(),
        journal,
        bypass,
        &by,
    )
}
fn retained_connection(root: &Path) -> Connection {
    Connection::open_with_flags(
        root.join("recovery.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}
#[derive(Debug, PartialEq)]
struct CopyRow {
    id: String,
    state: String,
    before: String,
    after: String,
    captured_at: i64,
    bytes: Vec<u8>,
    join: String,
}
fn one_copy(root: &Path) -> CopyRow {
    let conn = retained_connection(root);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    conn.query_row(
        "SELECT id,state,before_hash,after_hash,captured_at,bytes,selected_join FROM copies",
        [],
        |r| {
            Ok(CopyRow {
                id: r.get(0)?,
                state: r.get(1)?,
                before: r.get(2)?,
                after: r.get(3)?,
                captured_at: r.get(4)?,
                bytes: r.get(5)?,
                join: r.get(6)?,
            })
        },
    )
    .unwrap()
}
fn pending(f: &Fixture) -> PathBuf {
    f.db.parent().unwrap().join("pending-change")
}
fn envelope(f: &Fixture) -> Value {
    serde_json::from_slice(&fs::read(pending(f).join("intent.json")).unwrap()).unwrap()
}
fn assert_original_join(row: &CopyRow, intent: &Value) {
    assert_eq!(row.bytes, BEFORE.as_bytes());
    assert_eq!(row.before, crate::ledger::sha256_hex(BEFORE.as_bytes()));
    assert_eq!(row.after, crate::ledger::sha256_hex(AFTER.as_bytes()));
    assert!(row.join.len() <= 1024);
    let join: Value = serde_json::from_str(&row.join).unwrap();
    assert_eq!(join["version"], 1);
    assert_eq!(join["operation_id"], intent["operation_id"]);
    assert_eq!(join["workspace_id"], WORKSPACE);
    assert_eq!(join["record_id"], RECORD);
    assert_eq!(join["intent_identity_sha256"].as_str().unwrap().len(), 64);
    assert_eq!(intent["retained_copy"]["id"], row.id);
    assert_eq!(intent["retained_copy"]["captured_at"], row.captured_at);
    let at =
        chrono::DateTime::parse_from_rfc3339(intent["receipt"]["at"].as_str().unwrap()).unwrap();
    assert_eq!(at.timestamp(), row.captured_at);
    assert!(row.captured_at > 0 && row.captured_at <= chrono::Utc::now().timestamp());
}

#[test]
fn protected_retention_capture_precedes_real_body_install_and_keeps_original_identity() {
    let f = fixture("protected-capture");
    let exact_metadata = metadata_source(&f);
    f.run(|| {
        let (journal, root) = journal(&f);
        let expected = f.version();
        let captured = std::rc::Rc::new(std::cell::RefCell::new(None));
        let at_hook = captured.clone();
        let root_at_hook = root.clone();
        let pending_at_hook = pending(&f);
        let body_at_hook = f.root.join("page.md");
        let saved = selected::with_before_install_for_test(move || {
            let row = one_copy(&root_at_hook);
            let intent: Value = serde_json::from_slice(&fs::read(pending_at_hook.join("intent.json")).unwrap()).unwrap();
            assert_eq!(row.state, "pending");
            assert_eq!(fs::read(body_at_hook).unwrap(), BEFORE.as_bytes());
            assert_original_join(&row, &intent);
            *at_hook.borrow_mut() = Some((row, intent));
        }, || protected(&f, &journal, &expected, None)).unwrap();
        let (original, intent) = captured.borrow_mut().take().expect("real install boundary was reached");
        assert!(matches!(saved.pair, SelectedBodyAck::Applied { ref operation_id, .. } if operation_id == intent["operation_id"].as_str().unwrap()));
        assert!(matches!(saved.recovery, Outcome::Retained { ref id, .. } if id == &original.id));
        let final_row = one_copy(&root);
        assert_eq!(final_row.state, "committed");
        assert_eq!(final_row.join, original.join);
        assert_eq!(metadata_source(&f), exact_metadata);
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        assert!(!pending(&f).exists());
    });
}

#[test]
fn protected_retention_capture_failure_blocks_before_publication_and_omission_is_one_use() {
    let f = fixture("protected-storage-failure");
    f.run(|| {
        let (journal, root) = journal(&f);
        let expected = f.version();
        let database = root.join("recovery.sqlite");
        let saved_database = root.join("recovery.sqlite.saved");
        fs::rename(&database, &saved_database).unwrap();
        fs::create_dir(&database).unwrap();
        let error = protected(&f, &journal, &expected, None).unwrap_err();
        let ProtectedBodyError::Retention(message) = error else {
            panic!("capture failure lost its explicit retained-copy choice: {error:?}");
        };
        let nonce = message
            .strip_prefix("recovery_required:")
            .expect("original omission choice");
        assert!(journal.failure(&f.root, "page.md", nonce).is_ok());
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        assert!(!pending(&f).exists());
        let saved = protected(&f, &journal, &expected, Some(nonce)).unwrap();
        assert!(matches!(saved.pair, SelectedBodyAck::Applied { .. }));
        assert_eq!(saved.recovery, Outcome::WithoutCopy);
        assert!(protected(&f, &journal, &f.version(), Some(nonce)).is_err());
        assert_eq!(receipt_count(&f), 1);
        fs::remove_dir(&database).unwrap();
        fs::rename(&saved_database, &database).unwrap();
        assert!(journal.enabled(&f.root).unwrap());
        assert_eq!(
            retained_connection(&root)
                .query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    });
}

#[test]
fn protected_retention_finalization_failure_keeps_real_applied_ack_and_pending_evidence() {
    let f = fixture("protected-finalize");
    f.run(|| {
        let (journal, root) = journal(&f);
        let expected = f.version();
        let database = root.join("recovery.sqlite");
        let saved_database = root.join("recovery.sqlite.saved");
        let at_hook = database.clone();
        let saved_at_hook = saved_database.clone();
        let saved = selected::with_after_commit_for_test(
            move || {
                fs::rename(&at_hook, &saved_at_hook).unwrap();
                fs::create_dir(&at_hook).unwrap();
            },
            || protected(&f, &journal, &expected, None),
        )
        .unwrap();
        assert!(matches!(saved.pair, SelectedBodyAck::Applied { .. }));
        let Outcome::Pending { id, .. } = saved.recovery else {
            panic!("durable body must acknowledge pending copy settlement");
        };
        assert_eq!(state(&f), (12, 5, 8));
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), AFTER.as_bytes());
        // Explicitly revised after root's retirement-first protocol review:
        // the original precommit capture was verified under uninterrupted locks.
        // M93 finalization failure cannot re-block the coherent committed page.
        assert!(!pending(&f).exists());
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        assert_eq!(
            recovery::recover_workspace(&f.root).unwrap(),
            RecoveryReport::Clean
        );
        fs::remove_dir(&database).unwrap();
        fs::rename(&saved_database, &database).unwrap();
        assert_eq!(one_copy(&root).id, id);
        assert_eq!(one_copy(&root).state, "pending");
        let recovered = recovery::recover_workspace_with_retention(&f.root, &journal).unwrap();
        assert_eq!(recovered, RecoveryReport::Clean);
        assert_eq!(one_copy(&root).state, "pending");
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        assert_eq!(
            recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
            RecoveryReport::Clean
        );
    });
}

fn stopped_protected(f: &Fixture, point: &str) {
    stopped_protected_action(f, point, false);
}
fn stopped_protected_action(f: &Fixture, point: &str, recover: bool) {
    let output = f.origin.join("protected-child-output.txt");
    let file = fs::File::create(&output).unwrap();
    let mut child = crate::spawn::command(std::env::current_exe().unwrap())
        .args([
            "workspace_service::selected_tests::paired::retained::protected_retention_stop_child",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_remove("CEREBRO_CRASH_POINT")
        .env("CEREBRO_STOP_POINT", point)
        .env("CEREBRO_PROTECTED_PAIR_ROOT", &f.root)
        .env("CEREBRO_PROTECTED_PAIR_ORIGIN", &f.origin)
        .env(
            "CEREBRO_PROTECTED_PAIR_RECOVER",
            if recover { "1" } else { "0" },
        )
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
            panic!("owned protected pair child exceeded deadline at {point}");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut text = String::new();
    fs::File::open(output)
        .unwrap()
        .take(65536)
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(
        status.code(),
        Some(86),
        "protected facade never reached real {point}: {text}"
    );
}

#[test]
fn protected_retention_stop_child() {
    let Ok(root) = std::env::var("CEREBRO_PROTECTED_PAIR_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let origin = PathBuf::from(std::env::var("CEREBRO_PROTECTED_PAIR_ORIGIN").unwrap());
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
        let (journal, _) = journal(&f);
        if std::env::var("CEREBRO_PROTECTED_PAIR_RECOVER").as_deref() == Ok("1") {
            recovery::recover_workspace_with_retention(&f.root, &journal).unwrap();
        } else {
            protected(&f, &journal, &f.version(), None).unwrap();
        }
    });
}

#[test]
fn protected_retention_real_exit86_recovers_the_original_join_once() {
    for point in [
        "selected-journal-durable",
        "selected-body-renamed",
        "selected-metadata-committed",
    ] {
        let f = fixture(point);
        stopped_protected(&f, point);
        f.run(|| {
            let root = f.origin.join("retained-copies");
            let original = one_copy(&root);
            let intent = envelope(&f);
            assert_original_join(&original, &intent);
            let journal = Journal::open(&root).unwrap();
            journal.status(&f.root).unwrap();
            assert_eq!(
                one_copy(&root),
                original,
                "setup/access cleanup cannot classify selected capture"
            );
            let result = recovery::recover_workspace_with_retention(&f.root, &journal).unwrap();
            let committed = point == "selected-metadata-committed";
            assert!(if committed {
                matches!(result, RecoveryReport::Completed { .. })
            } else {
                matches!(result, RecoveryReport::RolledBack { .. })
            });
            if committed {
                let row = one_copy(&root);
                assert_eq!(row.state, "committed");
                assert_eq!(row.join, original.join);
            } else {
                assert_eq!(
                    retained_connection(&root)
                        .query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    0
                );
            }
            assert_eq!(receipt_count(&f), i64::from(committed));
            assert_eq!(
                selected::read_body(&f.root, "page.md").unwrap(),
                if committed { AFTER } else { BEFORE }
            );
            assert_eq!(
                recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
                RecoveryReport::Clean
            );
        });
    }
}

#[test]
fn protected_retention_missing_or_substituted_copy_keeps_nonexpired_intent() {
    for remove in [false, true] {
        let f = fixture("protected-mismatched-copy");
        stopped_protected(&f, "selected-metadata-committed");
        f.run(|| {
            let root = f.origin.join("retained-copies");
            let original = one_copy(&root);
            let conn = Connection::open(root.join("recovery.sqlite")).unwrap();
            if remove {
                conn.execute("DELETE FROM copies WHERE id=?1", [&original.id])
                    .unwrap();
            } else {
                let mut join: Value = serde_json::from_str(&original.join).unwrap();
                join["operation_id"] = json!("075cf03a-1936-4cc1-bd31-22f29f574e19");
                conn.execute(
                    "UPDATE copies SET selected_join=?2 WHERE id=?1",
                    rusqlite::params![original.id, join.to_string()],
                )
                .unwrap();
            }
            drop(conn);
            let intent = fs::read(pending(&f).join("intent.json")).unwrap();
            let journal = Journal::open(&root).unwrap();
            assert!(recovery::recover_workspace_with_retention(&f.root, &journal).is_err());
            assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), intent);
            assert_eq!(fs::read(f.root.join("page.md")).unwrap(), AFTER.as_bytes());
            assert_eq!(receipt_count(&f), 1);
        });
    }
}

#[test]
fn protected_retention_reference_time_cannot_invent_expiry() {
    for captured in [
        json!(-1),
        json!(0),
        json!(chrono::Utc::now().timestamp() + 86400),
        json!("expired"),
    ] {
        let f = fixture("protected-reference-time");
        stopped_protected(&f, "selected-metadata-committed");
        f.run(|| {
            let root = f.origin.join("retained-copies");
            let original = one_copy(&root);
            let mut intent = envelope(&f);
            intent["retained_copy"]["captured_at"] = captured;
            let bytes = serde_json::to_vec(&intent).unwrap();
            fs::write(pending(&f).join("intent.json"), &bytes).unwrap();
            let journal = Journal::open(&root).unwrap();
            assert!(recovery::recover_workspace_with_retention(&f.root, &journal).is_err());
            assert_eq!(one_copy(&root), original);
            assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), bytes);
            assert_eq!(receipt_count(&f), 1);
        });
    }
}

#[test]
fn protected_retention_recovery_preserves_existing_lock_free_v2_open() {
    let f = Fixture::new("protected-recovery-v2");
    f.run(|| {
        let (journal, root) = journal(&f);
        let before_database = fs::read(&f.db).unwrap();
        let before_body = fs::read(f.root.join("page.md")).unwrap();
        assert_eq!(
            recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
            RecoveryReport::Clean
        );
        assert_eq!(fs::read(&f.db).unwrap(), before_database);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), before_body);
        assert!(!f.db.parent().unwrap().join("selected.lock").exists());
        assert_eq!(
            retained_connection(&root)
                .query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    });
}

#[test]
fn protected_retention_capture_only_stop_keeps_unproven_copy_pending() {
    let f = fixture("protected-capture-only");
    stopped_protected(&f, "selected-retention-captured");
    f.run(|| {
        let root = f.origin.join("retained-copies");
        let original = one_copy(&root);
        assert_eq!(original.state, "pending");
        assert_eq!(original.bytes, BEFORE.as_bytes());
        assert!(!pending(&f).exists());
        let journal = Journal::open(&root).unwrap();
        assert_eq!(
            recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
            RecoveryReport::Clean
        );
        journal.status(&f.root).unwrap();
        assert_eq!(one_copy(&root), original);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), BEFORE);
        assert_eq!(receipt_count(&f), 0);
    });
}

#[test]
fn protected_retention_retirement_gaps_keep_coherent_pages_and_pending_bytes() {
    for committed in [false, true] {
        let f = fixture("protected-retirement-gap");
        if committed {
            stopped_protected(&f, "selected-retention-new-retired");
        } else {
            stopped_protected(&f, "selected-body-renamed");
            stopped_protected_action(&f, "selected-retention-old-retired", true);
        }
        f.run(|| {
            let root = f.origin.join("retained-copies");
            let original = one_copy(&root);
            assert_eq!(original.state, "pending");
            assert!(!pending(&f).exists());
            let journal = Journal::open(&root).unwrap();
            assert_eq!(
                recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
                RecoveryReport::Clean
            );
            assert_eq!(
                recovery::recover_workspace(&f.root).unwrap(),
                RecoveryReport::Clean
            );
            assert_eq!(
                selected::read_body(&f.root, "page.md").unwrap(),
                if committed { AFTER } else { BEFORE }
            );
            assert_eq!(receipt_count(&f), i64::from(committed));
            journal.status(&f.root).unwrap();
            assert_eq!(
                one_copy(&root),
                original,
                "absence of paired intent cannot prove the retained-copy outcome"
            );
        });
    }
}

#[test]
fn protected_retention_completed_settlement_stop_reopens_without_duplicate_receipt() {
    for committed in [false, true] {
        let f = fixture("protected-settlement-stop");
        if committed {
            stopped_protected(&f, "selected-retention-committed");
        } else {
            stopped_protected(&f, "selected-body-renamed");
            stopped_protected_action(&f, "selected-retention-rollback-deleted", true);
        }
        f.run(|| {
            let root = f.origin.join("retained-copies");
            let journal = Journal::open(&root).unwrap();
            assert!(!pending(&f).exists());
            assert_eq!(
                recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
                RecoveryReport::Clean
            );
            assert_eq!(receipt_count(&f), i64::from(committed));
            if committed {
                assert_eq!(one_copy(&root).state, "committed");
            } else {
                assert_eq!(
                    retained_connection(&root)
                        .query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    0
                );
            }
        });
    }
}

#[test]
fn protected_retention_full_digest_binds_permissions_final_copy_id_and_valid_time() {
    for changed in ["permissions", "copy_id", "valid_time"] {
        let f = fixture("protected-full-digest");
        stopped_protected(&f, "selected-journal-durable");
        f.run(|| {
            let root = f.origin.join("retained-copies");
            let original = one_copy(&root);
            let mut intent = envelope(&f);
            let conn = Connection::open(root.join("recovery.sqlite")).unwrap();
            match changed {
                "permissions" => {
                    intent["body_permissions"] =
                        json!(intent["body_permissions"].as_u64().unwrap() ^ 0o020)
                }
                "copy_id" => {
                    let replacement = "65a480581e784673b89bda8f89893978";
                    intent["retained_copy"]["id"] = json!(replacement);
                    conn.execute(
                        "UPDATE copies SET id=?2 WHERE id=?1",
                        rusqlite::params![original.id, replacement],
                    )
                    .unwrap();
                }
                _ => {
                    let past = original.captured_at - 1;
                    intent["retained_copy"]["captured_at"] = json!(past);
                    intent["receipt"]["at"] =
                        json!(chrono::DateTime::<chrono::Utc>::from_timestamp(past, 0)
                            .unwrap()
                            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
                    conn.execute(
                        "UPDATE copies SET captured_at=?2 WHERE id=?1",
                        rusqlite::params![original.id, past],
                    )
                    .unwrap();
                }
            }
            drop(conn);
            let changed_row = one_copy(&root);
            assert_eq!(
                changed_row.join, original.join,
                "fixture must retain the actual original digest"
            );
            let bytes = serde_json::to_vec(&intent).unwrap();
            fs::write(pending(&f).join("intent.json"), &bytes).unwrap();
            let journal = Journal::open(&root).unwrap();
            assert_eq!(
                recovery::recover_workspace_with_retention(&f.root, &journal)
                    .unwrap_err()
                    .kind,
                AuthorityErrorKind::RecoveryConflict
            );
            assert_eq!(one_copy(&root), changed_row);
            assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), bytes);
            assert_eq!(state(&f), (11, 5, 7));
            assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        });
    }
}

#[test]
fn protected_retention_missing_row_and_valid_past_timestamp_never_authenticate_expiry() {
    let f = fixture("protected-unproven-expiry");
    stopped_protected(&f, "selected-journal-durable");
    f.run(|| {
        let root = f.origin.join("retained-copies");
        let original = one_copy(&root);
        let conn = Connection::open(root.join("recovery.sqlite")).unwrap();
        conn.execute("DELETE FROM copies WHERE id=?1", [original.id])
            .unwrap();
        drop(conn);
        let mut intent = envelope(&f);
        let past =
            chrono::Utc::now().timestamp() - crate::vault::recovery::limits().retention_seconds - 1;
        intent["retained_copy"]["captured_at"] = json!(past);
        intent["receipt"]["at"] = json!(chrono::DateTime::<chrono::Utc>::from_timestamp(past, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        let bytes = serde_json::to_vec(&intent).unwrap();
        fs::write(pending(&f).join("intent.json"), &bytes).unwrap();
        let journal = Journal::open(&root).unwrap();
        assert_eq!(
            recovery::recover_workspace_with_retention(&f.root, &journal)
                .unwrap_err()
                .kind,
            AuthorityErrorKind::RecoveryConflict
        );
        assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), bytes);
        assert_eq!(state(&f), (11, 5, 7));
    });
}

#[test]
fn protected_retention_omission_cannot_follow_a_changed_canonical_version() {
    let f = fixture("protected-choice-version");
    f.run(|| {
        let (journal,root) = journal(&f);
        let expected = f.version();
        let database = root.join("recovery.sqlite");
        let saved = root.join("recovery.sqlite.saved");
        fs::rename(&database,&saved).unwrap(); fs::create_dir(&database).unwrap();
        let error = protected(&f,&journal,&expected,None).unwrap_err();
        let ProtectedBodyError::Retention(message) = error else { panic!("expected explicit retention choice"); };
        let nonce = message.strip_prefix("recovery_required:").unwrap();
        fs::remove_dir(&database).unwrap(); fs::rename(&saved,&database).unwrap();
        mutate(&f,expected,SelectedMode::Default).unwrap();
        let before_state = state(&f);
        assert!(matches!(protected(&f,&journal,&f.version(),Some(nonce)),Err(ProtectedBodyError::Retention(message)) if message == "recovery_bypass_invalid"));
        assert_eq!(state(&f),before_state);
        assert_eq!(receipt_count(&f),1);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(),BEFORE.as_bytes());
        assert!(journal.enabled(&f.root).unwrap());
    });
}

#[test]
fn protected_retention_off_privacy_and_entry_limit_keep_their_distinct_outcomes() {
    for reason in ["off", "privacy", "entry_limit"] {
        let f = fixture("protected-policy");
        f.run(|| {
            let (journal, root) = journal(&f);
            let path = if reason == "privacy" {
                fs::create_dir_all(f.root.join("sources/mail")).unwrap();
                fs::rename(
                    f.root.join("page.md"),
                    f.root.join("sources/mail/thread.md"),
                )
                .unwrap();
                f.conn()
                    .execute(
                        "UPDATE records SET path='sources/mail/thread.md' WHERE id=?1",
                        [RECORD],
                    )
                    .unwrap();
                "sources/mail/thread.md"
            } else {
                "page.md"
            };
            if reason == "off" {
                journal.set_enabled(&f.root, false).unwrap();
            }
            if reason == "entry_limit" {
                let before = "x".repeat(10_485_761);
                fs::write(f.root.join(path), before.as_bytes()).unwrap();
                f.conn()
                    .execute(
                        "UPDATE records SET body_hash=?2 WHERE id=?1",
                        rusqlite::params![RECORD, crate::ledger::sha256_hex(before.as_bytes())],
                    )
                    .unwrap();
            }
            let by = crate::vault::receipt::WriteReceipt::ipc(
                crate::knowledge::guard_human_write(path).unwrap(),
            );
            let saved = cutover::commit_workspace_change_with_recovery(
                &f.root,
                path,
                &f.version(),
                AFTER.as_bytes(),
                &journal,
                None,
                &by,
            )
            .unwrap();
            assert!(matches!(saved.pair, SelectedBodyAck::Applied { .. }));
            assert_eq!(
                saved.recovery,
                if reason == "off" {
                    Outcome::Off
                } else {
                    Outcome::NotRetained {
                        reason: reason.into(),
                    }
                }
            );
            assert_eq!(
                retained_connection(&root)
                    .query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(fs::read(f.root.join(path)).unwrap(), AFTER.as_bytes());
            assert_eq!(receipt_count(&f), 1);
        });
    }
}

#[test]
fn protected_retention_pending_capacity_refuses_without_evicting_evidence() {
    let f = fixture("protected-pending-capacity");
    f.run(|| {
        let (journal, root) = journal(&f);
        let workspace = fs::File::options()
            .read(true)
            .write(true)
            .open(f.db.parent().unwrap().join("selected.lock"))
            .unwrap();
        workspace.try_lock().unwrap();
        let lock = crate::vault::write::lock_selected_path(&f.root, "page.md").unwrap();
        for _ in 0..1000 {
            crate::vault::recovery::prepare_selected_sweep_fixture(
                &journal, &lock, &f.root, "page.md", BEFORE, AFTER,
            )
            .unwrap();
        }
        drop(lock);
        drop(workspace);
        let error = protected(&f, &journal, &f.version(), None).unwrap_err();
        let ProtectedBodyError::Retention(message) = error else {
            panic!("expected explicit capacity choice");
        };
        let nonce = message.strip_prefix("recovery_required:").unwrap();
        assert_eq!(
            journal.failure(&f.root, "page.md", nonce).unwrap().reason,
            "pending_capacity"
        );
        assert_eq!(
            retained_connection(&root)
                .query_row(
                    "SELECT count(*) FROM copies WHERE state='pending'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1000
        );
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        assert!(!pending(&f).exists());
    });
}

#[test]
fn protected_retention_real_expiry_removes_bytes_but_does_not_authenticate_missing_join() {
    let f = fixture("protected-expiry-limit");
    stopped_protected(&f, "selected-metadata-committed");
    f.run(|| {
        let root = f.origin.join("retained-copies");
        let original = one_copy(&root);
        let intent = fs::read(pending(&f).join("intent.json")).unwrap();
        let journal = Journal::open(&root).unwrap();
        crate::vault::recovery::with_clock_offset_for_test(604801, || {
            journal.sweep_all().unwrap();
            assert_eq!(
                retained_connection(&root)
                    .query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                recovery::recover_workspace_with_retention(&f.root, &journal)
                    .unwrap_err()
                    .kind,
                AuthorityErrorKind::RecoveryConflict
            );
        });
        // No mutable timestamp or synthetic join was used to force this expiry.
        assert!(original.captured_at > 0);
        assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), intent);
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), AFTER.as_bytes());
    });
}

#[test]
fn protected_retention_omission_rejects_changed_draft_and_expired_choice() {
    for expired in [false, true] {
        let f = fixture("protected-choice-draft-expiry");
        f.run(|| {
            let (journal,root) = journal(&f);
            let expected = f.version();
            let database = root.join("recovery.sqlite");
            let saved = root.join("recovery.sqlite.saved");
            fs::rename(&database,&saved).unwrap(); fs::create_dir(&database).unwrap();
            let ProtectedBodyError::Retention(message) = protected(&f,&journal,&expected,None).unwrap_err() else { panic!("expected actual retention choice"); };
            let nonce = message.strip_prefix("recovery_required:").unwrap();
            fs::remove_dir(&database).unwrap(); fs::rename(&saved,&database).unwrap();
            let by = crate::vault::receipt::WriteReceipt::ipc(crate::knowledge::guard_human_write("page.md").unwrap());
            let result = if expired {
                crate::vault::recovery::with_clock_offset_for_test(601,|| cutover::commit_workspace_change_with_recovery(&f.root,"page.md",&expected,AFTER.as_bytes(),&journal,Some(nonce),&by))
            } else {
                cutover::commit_workspace_change_with_recovery(&f.root,"page.md",&expected,b"# A changed draft\n",&journal,Some(nonce),&by)
            };
            assert!(matches!(result,Err(ProtectedBodyError::Retention(message)) if message == "recovery_bypass_invalid"));
            assert_eq!(state(&f),(11,5,7));
            assert_eq!(receipt_count(&f),0);
            assert_eq!(fs::read(f.root.join("page.md")).unwrap(),BEFORE.as_bytes());
            assert!(journal.enabled(&f.root).unwrap());
        });
    }
}

#[test]
fn protected_retention_actual_selected_open_requires_original_join_before_scan() {
    for committed in [false, true] {
        let f = fixture("protected-startup-consumer");
        stopped_protected(
            &f,
            if committed {
                "selected-metadata-committed"
            } else {
                "selected-body-renamed"
            },
        );
        f.run(|| {
            let intent = fs::read(pending(&f).join("intent.json")).unwrap();
            assert!(crate::prepare_selected_open_with_retention(&f.root, None).is_err());
            assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), intent);
            let journal = Journal::open(&f.origin.join("retained-copies")).unwrap();
            crate::prepare_selected_open_with_retention(&f.root, Some(&journal)).unwrap();
            assert_eq!(
                selected::read_body(&f.root, "page.md").unwrap(),
                if committed { AFTER } else { BEFORE }
            );
            assert_eq!(receipt_count(&f), i64::from(committed));
            assert!(!pending(&f).exists());
        });
    }
}

fn joined_copy_survives_later_positive_legacy_authority(point: &str) {
    let f = fixture("joined-copy-later-legacy");
    // The real child owns the original selected observation. This process has
    // never observed this root; the fresh context models the next app start.
    stopped_protected(&f, point);
    let root = f.origin.join("retained-copies");
    let original = one_copy(&root);
    assert_eq!(original.state, "pending");
    assert_original_join(&original, &envelope(&f));
    let intent = fs::read(pending(&f).join("intent.json")).unwrap();
    let body = fs::read(f.root.join("page.md")).unwrap();
    let database = fs::read(&f.db).unwrap();
    fs::remove_file(f.origin.join("workspaces/bindings.v1.json")).unwrap();
    fs::remove_file(f.root.join(".cerebro/workspace-format.json")).unwrap();
    f.run(|| {
        assert!(
            matches!(
                authority::resolve(&f.root).unwrap(),
                authority::Authority::Legacy
            ),
            "the actual current classifier, not a substituted observer, must be Legacy"
        );
        let journal = Journal::open(&root).unwrap();
        assert_eq!(
            one_copy(&root),
            original,
            "setup sweep must preserve the durable selected join despite current Legacy authority"
        );
        journal.status(&f.root).unwrap();
        journal.sweep_all().unwrap();
        assert_eq!(
            one_copy(&root),
            original,
            "access and periodic sweep must not infer a selected operation from its visible body"
        );
        assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), intent);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), body);
        assert_eq!(fs::read(&f.db).unwrap(), database);
    });
}

#[test]
fn protected_retention_joined_old_body_stays_pending_after_later_legacy_classification() {
    joined_copy_survives_later_positive_legacy_authority("selected-journal-durable");
}

#[test]
fn protected_retention_joined_new_body_stays_pending_after_later_legacy_classification() {
    joined_copy_survives_later_positive_legacy_authority("selected-metadata-committed");
}

#[test]
fn protected_retention_pending_intent_refuses_a_prematurely_committed_join() {
    let f = fixture("prematurely-committed-join");
    stopped_protected(&f, "selected-metadata-committed");
    f.run(|| {
        let root = f.origin.join("retained-copies");
        let original = one_copy(&root);
        assert_eq!(original.state, "pending");
        assert_original_join(&original, &envelope(&f));
        // Corrupt only a real captured row. No supported retirement-first
        // producer commits this row while its paired intent is still pending.
        let conn = Connection::open(root.join("recovery.sqlite")).unwrap();
        assert_eq!(
            conn.execute(
                "UPDATE copies SET state='committed' WHERE id=?1 AND state='pending'",
                [&original.id]
            )
            .unwrap(),
            1
        );
        drop(conn);
        let substituted = one_copy(&root);
        let intent = fs::read(pending(&f).join("intent.json")).unwrap();
        let database = fs::read(&f.db).unwrap();
        let journal = Journal::open(&root).unwrap();
        assert_eq!(
            recovery::recover_workspace_with_retention(&f.root, &journal)
                .unwrap_err()
                .kind,
            AuthorityErrorKind::RecoveryConflict
        );
        assert_eq!(one_copy(&root), substituted);
        assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), intent);
        assert_eq!(fs::read(&f.db).unwrap(), database);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), AFTER.as_bytes());
        assert_eq!(receipt_count(&f), 1);
    });
}
