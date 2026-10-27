#![cfg(test)]
//! Actual save_note helper and private-v3 fixtures. Closed editor APIs establish
//! missing-functionality RED; this is not a regression of explicit body CAS.
use super::*;
use crate::vault::recovery::Journal;
use crate::workspace_service::selected::EditorRecoveryView as Outcome;
use crate::workspace_service::selected::{
    EditorBodyCoherence, EditorSavePhase, EditorSaveRequest, EditorSaveResult, SelectedEditorTarget,
};

const EXTERNAL: &str = "\u{feff}---\r\ntype: Agent\r\n---\r\n# External B\r\n";
fn target() -> SelectedEditorTarget {
    SelectedEditorTarget {
        workspace_id: WORKSPACE.into(),
        record_id: RECORD.into(),
    }
}
fn journal(f: &Fixture, enabled: bool) -> Journal {
    let journal = Journal::open(&f.origin.join("retained-copies")).unwrap();
    journal.set_enabled(&f.root, enabled).unwrap();
    journal
}
fn save(
    f: &Fixture,
    journal: &Journal,
    body: &str,
    request: EditorSaveRequest,
) -> Result<crate::NoteSaveResult, String> {
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
    .map_err(|error| error.to_string())
}
fn fresh() -> EditorSaveRequest {
    EditorSaveRequest {
        target: target(),
        request_key: crate::workspace_migration::identity::mint_uuid_v4(),
        phase: EditorSavePhase::Start,
        expected_version: None,
        original: None,
    }
}
fn resolve(request: &EditorSaveRequest) -> EditorSaveRequest {
    EditorSaveRequest {
        phase: EditorSavePhase::Resolve,
        ..request.clone()
    }
}
fn pending(f: &Fixture) -> PathBuf {
    f.db.parent().unwrap().join("pending-change")
}
fn applied(ack: crate::NoteSaveResult) -> SelectedRecordVersion {
    match ack {
        crate::NoteSaveResult::Selected(EditorSaveResult::Applied { operation, .. }) => {
            operation.version
        }
        other => panic!("expected a real paired editor acknowledgement: {other:?}"),
    }
}
fn count_copies(f: &Fixture, state: &str) -> i64 {
    Connection::open_with_flags(
        f.origin.join("retained-copies/recovery.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
    .query_row("SELECT count(*) FROM copies WHERE state=?1", [state], |r| {
        r.get(0)
    })
    .unwrap()
}

#[test]
fn editor_save_uses_current_locked_version_and_preserves_metadata() {
    let f = fixture("editor-current-wins");
    f.run(|| {
        let journal = journal(&f, true);
        let original = f.version();
        let by = crate::vault::receipt::WriteReceipt::ipc(
            crate::knowledge::guard_human_write("page.md").unwrap(),
        );
        selected::set_full_width(&f.root, "page.md", &original, SelectedMode::Default, &by)
            .unwrap();
        let metadata = metadata_source(&f);
        let before = state(&f);
        let version = applied(save(&f, &journal, AFTER, fresh()).unwrap());
        assert_eq!(metadata_source(&f), metadata);
        assert_eq!(state(&f), (before.0 + 1, before.1, before.2 + 1));
        assert_eq!(version.metadata_revision, (before.2 + 1).to_string());
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        assert_eq!(count_copies(&f, "committed"), 1);
    });
}

#[test]
fn editor_snapshot_reads_exact_body_and_distinguishes_external_hash() {
    let f = fixture("editor-snapshot");
    f.run(|| {
        let original = f.version();
        fs::write(f.root.join("page.md"), EXTERNAL).unwrap();
        let snapshot = crate::read_editor_body(
            f.root.to_string_lossy().into_owned(),
            "page.md".into(),
            target(),
        )
        .unwrap();
        assert_eq!(snapshot.body, EXTERNAL);
        assert_eq!(snapshot.version, original);
        assert_eq!(
            snapshot.observed_body_hash,
            crate::ledger::sha256_hex(EXTERNAL.as_bytes())
        );
        assert_eq!(snapshot.coherence, EditorBodyCoherence::ExternalChange);
        assert!(snapshot.editable);
        assert_eq!(
            f.version(),
            original,
            "an observation cannot adopt an external body"
        );
        assert_eq!(receipt_count(&f), 0);
    });
}

#[test]
fn editor_save_external_b_is_captured_before_original_a_is_installed() {
    for enabled in [false, true] {
        let f = fixture("editor-displaced-B");
        f.run(|| {
            let journal = journal(&f, enabled);
            let canonical = f.version();
            fs::write(f.root.join("page.md"), EXTERNAL).unwrap();
            let pending_at_hook = pending(&f);
            let body_at_hook = f.root.join("page.md");
            let ack = selected::with_before_install_for_test(
                move || {
                    let intent: Value = serde_json::from_slice(
                        &fs::read(pending_at_hook.join("intent.json")).unwrap(),
                    )
                    .unwrap();
                    assert_eq!(intent["format"], 3);
                    assert_eq!(intent["canonical_before_body_hash"], canonical.body_hash);
                    assert_eq!(intent["recovery_disposition"], "complete_original");
                    assert_eq!(
                        fs::read(pending_at_hook.join("before.body")).unwrap(),
                        EXTERNAL.as_bytes()
                    );
                    assert_eq!(
                        fs::read(pending_at_hook.join("after.body")).unwrap(),
                        AFTER.as_bytes()
                    );
                    assert_eq!(fs::read(body_at_hook).unwrap(), EXTERNAL.as_bytes());
                },
                || save(&f, &journal, AFTER, fresh()),
            )
            .unwrap();
            let crate::NoteSaveResult::Selected(EditorSaveResult::Applied {
                recovery,
                operation,
                ..
            }) = ack
            else {
                panic!("paired editor save not applied")
            };
            assert_eq!(
                operation.receipt.body_before_hash,
                crate::ledger::sha256_hex(EXTERNAL.as_bytes())
            );
            assert_eq!(
                operation.receipt.body_after_hash,
                crate::ledger::sha256_hex(AFTER.as_bytes())
            );
            assert!(if enabled {
                matches!(recovery, Some(Outcome::Retained { .. }))
            } else {
                recovery == Some(Outcome::Off)
            });
            assert_eq!(receipt_count(&f), 1);
            assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
            assert!(!pending(&f).exists());
        });
    }
}

#[test]
fn editor_save_external_equal_draft_is_not_a_canonical_noop() {
    let f = fixture("editor-adopt-same-draft");
    f.run(|| {
        let journal = journal(&f, false);
        fs::write(f.root.join("page.md"), AFTER).unwrap();
        applied(save(&f, &journal, AFTER, fresh()).unwrap());
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        assert!(matches!(
            save(&f, &journal, AFTER, fresh()).unwrap(),
            crate::NoteSaveResult::Selected(EditorSaveResult::Unchanged { .. })
        ));
        assert_eq!(receipt_count(&f), 1);
    });
}

#[test]
fn editor_save_postintent_conflict_returns_pending_and_preserves_original() {
    let f = fixture("editor-pending");
    f.run(|| {
        let journal = journal(&f, true);
        fs::write(f.root.join("page.md"), EXTERNAL).unwrap();
        let body = f.root.join("page.md");
        let request = fresh();
        let ack = selected::with_before_install_for_test(
            move || fs::write(body, "# Third-party D\n").unwrap(),
            || save(&f, &journal, AFTER, request.clone()),
        )
        .unwrap();
        let crate::NoteSaveResult::Selected(EditorSaveResult::Pending { operation, .. }) = ack
        else {
            panic!("published original intent must remain in-progress")
        };
        let intent = fs::read(pending(&f).join("intent.json")).unwrap();
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(
            fs::read(f.root.join("page.md")).unwrap(),
            b"# Third-party D\n"
        );
        assert_eq!(count_copies(&f, "pending"), 1);
        assert!(save(
            &f,
            &journal,
            "# Newer draft\n",
            EditorSaveRequest {
                original: Some(operation.clone()),
                ..resolve(&request)
            }
        )
        .is_err());
        assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), intent);
        fs::write(f.root.join("page.md"), EXTERNAL).unwrap();
        applied(
            save(
                &f,
                &journal,
                AFTER,
                EditorSaveRequest {
                    original: Some(operation),
                    ..resolve(&request)
                },
            )
            .unwrap(),
        );
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
    });
}

#[test]
fn editor_save_changed_stable_identity_refuses_before_any_publication() {
    let f = fixture("editor-wrong-record");
    f.run(|| {
        let journal = journal(&f, true);
        let mut request = fresh();
        request.target.record_id = "075cf03a-1936-4cc1-bd31-22f29f574e19".into();
        assert!(save(&f, &journal, AFTER, request).is_err());
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(count_copies(&f, "pending"), 0);
        assert!(!pending(&f).exists());
    });
}

#[test]
fn editor_save_redo_child() {
    let Ok(root) = std::env::var("CEREBRO_EDITOR_PAIR_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let origin = PathBuf::from(std::env::var("CEREBRO_EDITOR_PAIR_ORIGIN").unwrap());
    for p in [&root, &origin] {
        assert!(p
            .canonicalize()
            .unwrap()
            .starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert!(p.file_name().unwrap().to_string_lossy().contains("m99-"));
    }
    let db = origin
        .join("workspaces")
        .join(WORKSPACE)
        .join("workspace.db");
    let f = std::mem::ManuallyDrop::new(Fixture { root, origin, db });
    f.run(|| {
        let journal = journal(&f, true);
        save(&f, &journal, AFTER, fresh()).unwrap();
    });
}
fn stopped_editor(f: &Fixture, point: &str) {
    let output = f.origin.join("editor-child-output.txt");
    let file = fs::File::create(&output).unwrap();
    let mut child = crate::spawn::command(std::env::current_exe().unwrap())
        .args([
            "workspace_service::selected_tests::paired::editor::editor_save_redo_child",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_remove("CEREBRO_CRASH_POINT")
        .env("CEREBRO_STOP_POINT", point)
        .env("CEREBRO_EDITOR_PAIR_ROOT", &f.root)
        .env("CEREBRO_EDITOR_PAIR_ORIGIN", &f.origin)
        .stdout(Stdio::from(file.try_clone().unwrap()))
        .stderr(Stdio::from(file))
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned editor child exceeded deadline")
        };
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
        "original editor operation did not reach {point}: {text}"
    );
}
#[test]
fn editor_save_redo_exit86_completes_valid_old_and_new_once() {
    for point in [
        "selected-journal-durable",
        "selected-body-temp-durable",
        "selected-body-renamed",
        "selected-receipt-staged",
        "selected-metadata-committed",
    ] {
        let f = fixture("editor-redo-reentry");
        fs::write(f.root.join("page.md"), EXTERNAL).unwrap();
        stopped_editor(&f, point);
        f.run(|| {
            let intent: Value =
                serde_json::from_slice(&fs::read(pending(&f).join("intent.json")).unwrap())
                    .unwrap();
            assert_eq!(intent["format"], 3);
            let journal = journal(&f, true);
            let result = recovery::recover_workspace_with_retention(&f.root, &journal).unwrap();
            assert!(
                matches!(result, RecoveryReport::Completed { .. }),
                "valid OLD drift intent must complete original A"
            );
            assert_eq!(receipt_count(&f), 1);
            assert_eq!(count_copies(&f, "committed"), 1);
            assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
            assert_eq!(
                recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
                RecoveryReport::Clean
            );
            assert_eq!(receipt_count(&f), 1);
        });
    }
}

#[test]
fn editor_save_two_owners_same_target_same_body_cannot_borrow_pending() {
    let f = fixture("editor-two-owners");
    f.run(|| {
        let journal = journal(&f, true);
        let first = fresh();
        let second = fresh();
        assert_ne!(first.request_key, second.request_key);
        let body = f.root.join("page.md");
        let result = selected::with_before_install_for_test(
            move || fs::write(body, "# Third-party D\n").unwrap(),
            || save(&f, &journal, AFTER, first.clone()),
        )
        .unwrap();
        assert!(matches!(
            result,
            crate::NoteSaveResult::Selected(EditorSaveResult::Pending { .. })
        ));
        let evidence = fs::read(pending(&f).join("intent.json")).unwrap();
        let intent: Value = serde_json::from_slice(&evidence).unwrap();
        assert_eq!(intent["request_key"], first.request_key);
        fs::write(f.root.join("page.md"), BEFORE).unwrap();
        for request in [second.clone(), resolve(&second)] {
            assert!(
                save(&f, &journal, AFTER, request).is_err(),
                "same bytes must not borrow another attempt"
            );
            assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), evidence);
            assert_eq!(receipt_count(&f), 0);
            assert_eq!(count_copies(&f, "pending"), 1);
        }
        applied(save(&f, &journal, AFTER, resolve(&first)).unwrap());
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(count_copies(&f, "committed"), 1);
    });
}
#[test]
fn editor_save_lost_reply_after_retire_confirms_current_only_and_never_reapplies() {
    let f = fixture("editor-lost-reply");
    f.run(|| {
        let journal = journal(&f, true);
        let first = fresh();
        let original = save(&f, &journal, AFTER, first.clone()).unwrap();
        let crate::NoteSaveResult::Selected(EditorSaveResult::Applied { operation, .. }) = original
        else {
            panic!("save must apply")
        };
        assert!(matches!(
            save(&f, &journal, AFTER, resolve(&first)).unwrap(),
            crate::NoteSaveResult::Selected(EditorSaveResult::Unchanged { .. })
        ));
        let newer = "# Newer editor write\n";
        applied(save(&f, &journal, newer, fresh()).unwrap());
        let state_before = state(&f);
        let receipts = receipt_count(&f);
        let copies = count_copies(&f, "committed");
        assert!(matches!(
            save(&f, &journal, AFTER, resolve(&first)).unwrap(),
            crate::NoteSaveResult::Selected(EditorSaveResult::OutcomeUnknown { .. })
        ));
        let known = EditorSaveRequest {
            original: Some(operation.clone()),
            ..resolve(&first)
        };
        let response = save(&f, &journal, AFTER, known).unwrap();
        let crate::NoteSaveResult::Selected(EditorSaveResult::Applied {
            operation: confirmed,
            reconcile_required,
            ..
        }) = response
        else {
            panic!("exact receipt was not confirmed")
        };
        assert_eq!(confirmed, operation);
        assert!(reconcile_required);
        assert_eq!(state(&f), state_before);
        assert_eq!(receipt_count(&f), receipts);
        assert_eq!(count_copies(&f, "committed"), copies);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), newer.as_bytes());
    });
}
#[test]
fn editor_save_resolve_before_dispatch_cannot_publish() {
    let f = fixture("editor-never-dispatched");
    f.run(|| {
        let journal = journal(&f, true);
        assert!(matches!(
            save(&f, &journal, AFTER, resolve(&fresh())).unwrap(),
            crate::NoteSaveResult::Selected(EditorSaveResult::OutcomeUnknown { .. })
        ));
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(count_copies(&f, "pending"), 0);
        assert_eq!(count_copies(&f, "committed"), 0);
        assert!(!pending(&f).exists());
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
    });
}
#[test]
fn editor_save_coherent_old_redo_completes_original_once() {
    let f = fixture("editor-coherent-redo");
    stopped_editor(&f, "selected-journal-durable");
    f.run(|| {
        let intent: Value =
            serde_json::from_slice(&fs::read(pending(&f).join("intent.json")).unwrap()).unwrap();
        assert_eq!(intent["format"], 3);
        assert_eq!(
            intent["before_body"]["hash"],
            intent["canonical_before_body_hash"]
        );
        assert_eq!(intent["request_key"].as_str().unwrap().len(), 36);
        let journal = journal(&f, true);
        assert!(matches!(
            recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
            RecoveryReport::Completed { .. }
        ));
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        assert_eq!(
            recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
            RecoveryReport::Clean
        );
        assert_eq!(receipt_count(&f), 1);
    });
}

#[test]
fn editor_save_request_key_is_bound_to_the_actual_retention_digest() {
    let f = fixture("editor-key-digest");
    stopped_editor(&f, "selected-journal-durable");
    f.run(|| {
        let journal = journal(&f, true);
        let file = pending(&f).join("intent.json");
        let mut intent: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        intent["request_key"] = Value::String(crate::workspace_migration::identity::mint_uuid_v4());
        let tampered = serde_json::to_vec(&intent).unwrap();
        fs::write(&file, &tampered).unwrap();
        assert_eq!(
            recovery::recover_workspace_with_retention(&f.root, &journal)
                .unwrap_err()
                .kind,
            AuthorityErrorKind::RecoveryConflict
        );
        assert_eq!(fs::read(&file).unwrap(), tampered);
        assert_eq!(count_copies(&f, "pending"), 1);
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
    });
}
#[test]
fn editor_save_malformed_attempt_key_refuses_before_capture() {
    let f = fixture("editor-bad-key");
    f.run(|| {
        let journal = journal(&f, true);
        for key in ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000"] {
            let mut request = fresh();
            request.request_key = key.into();
            assert!(save(&f, &journal, AFTER, request).is_err());
        }
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(count_copies(&f, "pending"), 0);
        assert!(!pending(&f).exists());
    });
}

#[test]
fn editor_save_receipt_wire_counters_are_lossless_decimal_strings() {
    let f = fixture("editor-wire-counters");
    f.run(|| {
        f.conn()
            .execute(
                "UPDATE workspace SET metadata_epoch=?1",
                [9_007_199_254_740_992_i64],
            )
            .unwrap();
        f.conn()
            .execute(
                "UPDATE records SET revision=?1 WHERE id=?2",
                rusqlite::params![9_007_199_254_740_992_i64, RECORD],
            )
            .unwrap();
        let journal = journal(&f, false);
        let ack = save(&f, &journal, AFTER, fresh()).unwrap();
        let wire = serde_json::to_value(&ack).unwrap();
        assert_eq!(wire["kind"], "selected_applied");
        assert_eq!(wire["operation"]["receipt"]["epoch"], "9007199254740993");
        assert_eq!(
            wire["operation"]["receipt"]["previousRevision"],
            "9007199254740992"
        );
        assert_eq!(wire["operation"]["receipt"]["revision"], "9007199254740993");
        assert_eq!(
            wire["operation"]["version"]["metadataRevision"],
            "9007199254740993"
        );
        assert_eq!(receipt_count(&f), 1);
    });
}

#[path = "selected_editor_boundary_tests.rs"]
mod boundaries;

#[path = "selected_editor_recovery_count_tests.rs"]
mod recovery_counts;

#[path = "selected_external_body_tests.rs"]
mod external_bodies;

#[test]
fn checklist_expected_metadata_revision_refuses_after_fresh_snapshot() {
    let f = fixture("checklist-metadata-interleave");
    f.run(|| {
        let journal = journal(&f, true);
        let snapshot = crate::read_editor_body(
            f.root.to_string_lossy().into_owned(),
            "page.md".into(),
            target(),
        )
        .unwrap();
        let mut request = fresh();
        request.expected_version = Some(snapshot.version.clone());
        let by = crate::vault::receipt::WriteReceipt::ipc(
            crate::knowledge::guard_human_write("page.md").unwrap(),
        );
        selected::set_full_width(
            &f.root,
            "page.md",
            &snapshot.version,
            SelectedMode::Default,
            &by,
        )
        .unwrap();
        let current = f.version();
        let metadata = metadata_source(&f);
        let before = state(&f);
        let receipts = receipt_count(&f);
        assert_eq!(
            current.body_hash, snapshot.version.body_hash,
            "interleaving changes metadata only"
        );
        let result = save(&f, &journal, AFTER, request);
        assert!(
            result.is_err(),
            "a dependent tick must refuse the stale metadata revision: {result:?}"
        );
        assert_eq!(f.version(), current);
        assert_eq!(state(&f), before);
        assert_eq!(metadata_source(&f), metadata);
        assert_eq!(receipt_count(&f), receipts);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        assert!(!pending(&f).exists());
        assert_eq!(count_copies(&f, "committed"), 0);
    });
}
#[test]
fn checklist_expected_body_refuses_external_change_after_fresh_snapshot() {
    let f = fixture("checklist-external-body-interleave");
    f.run(|| {
        let journal=journal(&f,true);
        let snapshot=crate::read_editor_body(f.root.to_string_lossy().into_owned(),"page.md".into(),target()).unwrap();
        let mut request=fresh(); request.expected_version=Some(snapshot.version.clone());
        fs::write(f.root.join("page.md"),EXTERNAL).unwrap();
        assert_eq!(f.version(),snapshot.version,"external bytes do not adopt a canonical revision");
        let before=state(&f); let metadata=metadata_source(&f);
        let result=save(&f,&journal,AFTER,request);
        assert!(result.is_err(),"a tick must refuse changed observed bytes rather than use the general editor winner rule: {result:?}");
        assert_eq!(state(&f),before); assert_eq!(metadata_source(&f),metadata); assert_eq!(receipt_count(&f),0);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(),EXTERNAL.as_bytes()); assert!(!pending(&f).exists());
        assert_eq!(count_copies(&f,"committed"),0);
    });
}
#[test]
fn checklist_expected_version_must_name_the_same_canonical_record() {
    let f = fixture("checklist-expected-wrong-record");
    f.run(|| {
        let journal = journal(&f, false);
        let mut expected = f.version();
        expected.record_id = TYPE.into();
        let mut request = fresh();
        request.expected_version = Some(expected);
        let before = state(&f);
        let result = save(&f, &journal, AFTER, request);
        assert!(
            result.is_err(),
            "an expectation cannot lend another record's identity: {result:?}"
        );
        assert_eq!(state(&f), before);
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), BEFORE);
    });
}
#[test]
fn checklist_matching_expected_version_reuses_actual_paired_writer_and_preserves_metadata() {
    let f = fixture("checklist-matching-cas-control");
    f.run(|| {
        let journal = journal(&f, true);
        let mut request = fresh();
        request.expected_version = Some(f.version());
        let metadata = metadata_source(&f);
        let before = state(&f);
        let version = applied(save(&f, &journal, AFTER, request).unwrap());
        assert_eq!(metadata_source(&f), metadata);
        assert_eq!(state(&f), (before.0 + 1, before.1, before.2 + 1));
        assert_eq!(
            version.body_hash,
            crate::ledger::sha256_hex(AFTER.as_bytes())
        );
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(count_copies(&f, "committed"), 1);
        assert!(!pending(&f).exists());
    });
}
#[test]
fn checklist_original_receipt_resolution_does_not_reapply_stale_expected_version() {
    let f = fixture("checklist-cas-resolve-control");
    f.run(|| {
        let journal = journal(&f, true);
        let mut request = fresh();
        request.expected_version = Some(f.version());
        let ack = save(&f, &journal, AFTER, request.clone()).unwrap();
        let crate::NoteSaveResult::Selected(EditorSaveResult::Applied { operation, .. }) = ack
        else {
            panic!("actual paired save not acknowledged");
        };
        let request = EditorSaveRequest {
            original: Some(operation.clone()),
            ..resolve(&request)
        };
        let replay = save(&f, &journal, AFTER, request).unwrap();
        let crate::NoteSaveResult::Selected(EditorSaveResult::Applied {
            operation: confirmed,
            ..
        }) = replay
        else {
            panic!("original receipt not resolved");
        };
        assert_eq!(confirmed, operation);
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(count_copies(&f, "committed"), 1);
    });
}
