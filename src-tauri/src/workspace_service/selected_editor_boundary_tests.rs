#![cfg(test)]
//! Additional actual command/recovery boundaries before native GREEN admission.
use super::*;
fn command(
    f: &Fixture,
    journal: &Journal,
    body: &str,
    request: EditorSaveRequest,
) -> Result<crate::NoteSaveResult, serde_json::Value> {
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
    .map_err(|e| serde_json::to_value(e).unwrap())
}
#[test]
fn editor_boundary_fresh_refusal_is_structured_without_publishing() {
    let f = fixture("editor-refusal-wire");
    f.run(|| {
        let journal = journal(&f, true);
        let mut request = fresh();
        request.target.record_id = TYPE.into();
        let error = command(&f, &journal, AFTER, request).unwrap_err();
        assert_eq!(error["kind"], "selected_refused");
        assert_eq!(error["error"]["kind"], "wrong_identity");
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(count_copies(&f, "pending"), 0);
        assert!(!pending(&f).exists());
    });
}
#[test]
fn editor_boundary_published_sync_failure_retains_original_pending() {
    let f = fixture("editor-sync-failure");
    f.run(|| {
        let journal = journal(&f, true);
        let request = fresh();
        let result = selected::with_published_sync_failure_for_test(|| {
            command(&f, &journal, AFTER, request.clone())
        })
        .unwrap();
        let crate::NoteSaveResult::Selected(EditorSaveResult::Pending { operation, .. }) = result
        else {
            panic!("uncertain publication was misreported as refused/applied")
        };
        assert_eq!(operation.request_key, request.request_key);
        assert!(pending(&f).exists());
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(count_copies(&f, "pending"), 1);
        let original = fs::read(pending(&f).join("intent.json")).unwrap();
        let request = EditorSaveRequest {
            original: Some(operation),
            ..resolve(&request)
        };
        applied(save(&f, &journal, AFTER, request).unwrap());
        let intent: Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(intent["request_key"].as_str().unwrap().len(), 36);
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        assert_eq!(count_copies(&f, "committed"), 1);
    });
}
#[test]
fn editor_boundary_capacity_trial_rolls_back_all_logical_state_before_capture() {
    let f = fixture("editor-trial-limit");
    f.run(|| {
        let journal = journal(&f, true);
        let exact = metadata_source(&f);
        let error =
            selected::with_sqlite_limit_for_test(1, || command(&f, &journal, AFTER, fresh()))
                .unwrap_err();
        assert_eq!(error["kind"], "selected_refused");
        assert_eq!(error["error"]["kind"], "source_limit");
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(metadata_source(&f), exact);
        assert_eq!(count_copies(&f, "pending"), 0);
        assert_eq!(count_copies(&f, "committed"), 0);
        assert!(!pending(&f).exists());
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        applied(save(&f, &journal, AFTER, fresh()).unwrap());
        assert_eq!(receipt_count(&f), 1);
    });
}
#[test]
fn editor_boundary_redo_capacity_retains_exact_evidence_then_completes() {
    let f = fixture("editor-redo-capacity");
    fs::write(f.root.join("page.md"), EXTERNAL).unwrap();
    stopped_editor(&f, "selected-journal-durable");
    f.run(|| {
        let journal = journal(&f, true);
        let intent = fs::read(pending(&f).join("intent.json")).unwrap();
        let error = selected::with_sqlite_limit_for_test(1, || {
            recovery::recover_workspace_with_retention(&f.root, &journal)
        })
        .unwrap_err();
        assert_eq!(error.kind, AuthorityErrorKind::SourceLimit);
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(fs::read(pending(&f).join("intent.json")).unwrap(), intent);
        assert_eq!(
            fs::read(pending(&f).join("before.body")).unwrap(),
            EXTERNAL.as_bytes()
        );
        assert_eq!(
            fs::read(pending(&f).join("after.body")).unwrap(),
            AFTER.as_bytes()
        );
        assert_eq!(
            fs::read(f.root.join("page.md")).unwrap(),
            EXTERNAL.as_bytes()
        );
        assert_eq!(count_copies(&f, "pending"), 1);
        assert!(matches!(
            recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
            RecoveryReport::Completed { .. }
        ));
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
    });
}
#[test]
fn editor_boundary_v2_does_not_create_lock_or_mutate_database() {
    let f = Fixture::new("editor-v2");
    f.run(|| {
        let journal = journal(&f, true);
        let database = fs::read(&f.db).unwrap();
        let error = command(&f, &journal, AFTER, fresh()).unwrap_err();
        assert_eq!(error["kind"], "selected_refused");
        assert_eq!(error["error"]["kind"], "unsupported_format");
        assert_eq!(fs::read(&f.db).unwrap(), database);
        assert!(!f.db.parent().unwrap().join("selected.lock").exists());
        assert_eq!(count_copies(&f, "pending"), 0);
    });
}
#[test]
fn editor_boundary_limits_identity_and_type_refuse_without_rows() {
    let f = fixture("editor-admission-controls");
    f.run(|| {
        let journal = journal(&f, true);
        let exact = metadata_source(&f);
        let oversized = "x".repeat(
            crate::workspace_service::authority::rules()
                .limits
                .body_bytes as usize
                + 1,
        );
        assert!(command(&f, &journal, &oversized, fresh()).is_err());
        let mut metadata = f.stored();
        metadata["value"]["type"] = json!({"kind":"string","value":"Agent"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![metadata.to_string(), RECORD],
            )
            .unwrap();
        let error = command(&f, &journal, AFTER, fresh()).unwrap_err();
        assert_eq!(error["kind"], "selected_refused");
        assert_eq!(error["error"]["kind"], "unsupported_operation");
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![exact, RECORD],
            )
            .unwrap();
        fs::hard_link(f.root.join("page.md"), f.root.join("body-alias.binary")).unwrap();
        assert!(command(&f, &journal, AFTER, fresh()).is_err());
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert_eq!(count_copies(&f, "pending"), 0);
        assert!(!pending(&f).exists());
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
    });
}
#[test]
fn editor_boundary_recovery_child() {
    let Ok(root) = std::env::var("CEREBRO_EDITOR_RECOVER_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let origin = PathBuf::from(std::env::var("CEREBRO_EDITOR_RECOVER_ORIGIN").unwrap());
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
        recovery::recover_workspace_with_retention(&f.root, &journal).unwrap();
    });
}
fn stopped_redo(f: &Fixture, point: &str) {
    let output = f.origin.join("editor-redo-child-output.txt");
    let file = fs::File::create(&output).unwrap();
    let mut child=crate::spawn::command(std::env::current_exe().unwrap()).args(["workspace_service::selected_tests::paired::editor::boundaries::editor_boundary_recovery_child","--exact","--nocapture","--test-threads=1"])
        .env_remove("CEREBRO_CRASH_POINT").env("CEREBRO_STOP_POINT",point).env("CEREBRO_EDITOR_RECOVER_ROOT",&f.root).env("CEREBRO_EDITOR_RECOVER_ORIGIN",&f.origin)
        .stdout(Stdio::from(file.try_clone().unwrap())).stderr(Stdio::from(file)).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned recovery child exceeded deadline")
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
        "redo did not reach {point}: {text}"
    );
}
#[test]
fn editor_boundary_redo_reentry_preserves_original_receipt_once() {
    for point in [
        "selected-body-temp-durable",
        "selected-recovery-new-renamed",
        "selected-editor-redo-receipt-staged",
        "selected-editor-redo-metadata-committed",
        "selected-retention-new-retired",
    ] {
        let f = fixture("editor-redo-crash");
        fs::write(f.root.join("page.md"), EXTERNAL).unwrap();
        stopped_editor(&f, "selected-journal-durable");
        let intent: Value =
            serde_json::from_slice(&fs::read(pending(&f).join("intent.json")).unwrap()).unwrap();
        // This child starts from the original editor's OLD/B pair. Do not open
        // fixture SQL here: the recovery child owns any hot-journal rollback.
        assert_eq!(
            fs::read(f.root.join("page.md")).unwrap(),
            EXTERNAL.as_bytes()
        );
        assert_eq!(
            intent["canonical_before_body_hash"],
            crate::ledger::sha256_hex(BEFORE.as_bytes())
        );
        assert_eq!(
            intent["before_body"]["hash"],
            crate::ledger::sha256_hex(EXTERNAL.as_bytes())
        );
        assert_eq!(
            intent["after_body"]["hash"],
            crate::ledger::sha256_hex(AFTER.as_bytes())
        );
        stopped_redo(&f, point);
        f.run(||{
            let journal=journal(&f,true);let report=recovery::recover_workspace_with_retention(&f.root,&journal).unwrap();
            assert!(matches!(report,RecoveryReport::Completed{..}|RecoveryReport::Clean));
            let receipt:Value=f.conn().query_row("SELECT epoch,record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at,body_before_hash,body_after_hash,run_id,approved_by FROM metadata_receipts",[],|r|Ok(json!({
                "workspace_id":WORKSPACE,"epoch":r.get::<_,i64>(0)?,"record_id":r.get::<_,String>(1)?,"previous_revision":r.get::<_,i64>(2)?,"revision":r.get::<_,i64>(3)?,
                "metadata_before_hash":r.get::<_,String>(4)?,"metadata_after_hash":r.get::<_,String>(5)?,"actor":r.get::<_,String>(6)?,"operation":r.get::<_,String>(7)?,"at":r.get::<_,String>(8)?,
                "body_before_hash":r.get::<_,String>(9)?,"body_after_hash":r.get::<_,String>(10)?,"run_id":r.get::<_,Option<String>>(11)?,"approved_by":r.get::<_,Option<String>>(12)?}))).unwrap();
            assert_eq!(receipt,intent["receipt"]);assert_eq!(receipt_count(&f),1);assert_eq!(selected::read_body(&f.root,"page.md").unwrap(),AFTER);
            if point=="selected-retention-new-retired"{assert_eq!(count_copies(&f,"pending"),1);assert_eq!(count_copies(&f,"committed"),0);}
            else{assert_eq!(count_copies(&f,"committed"),1);}
            assert_eq!(recovery::recover_workspace_with_retention(&f.root,&journal).unwrap(),RecoveryReport::Clean);assert_eq!(receipt_count(&f),1);
        });
    }
}
#[test]
fn editor_boundary_unprojectable_unrelated_metadata_is_preserved_exactly() {
    let f = fixture("editor-tagged-values");
    let mut metadata = f.stored();
    metadata["value"]["large"] = json!({"kind":"decimal","value":"1e400"});
    metadata["value"]["relation"] = json!({"kind":"relation","spelling":"[[Task]]","fragment":null,"resolution":{"status":"resolved","targetId":TYPE}});
    f.conn()
        .execute(
            "UPDATE records SET metadata=?1 WHERE id=?2",
            rusqlite::params![metadata.to_string(), RECORD],
        )
        .unwrap();
    let exact = metadata_source(&f);
    f.run(|| {
        let journal = journal(&f, true);
        applied(save(&f, &journal, AFTER, fresh()).unwrap());
        assert_eq!(metadata_source(&f), exact);
        assert_eq!(f.stored(), metadata);
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
    });
}
#[test]
fn editor_boundary_retention_choice_is_preintent_exact_and_one_use() {
    let f = fixture("editor-retention-choice");
    f.run(|| {
        let journal = journal(&f, true);
        let request = fresh();
        let db = f.origin.join("retained-copies/recovery.sqlite");
        let saved = db.with_extension("saved");
        fs::rename(&db, &saved).unwrap();
        fs::create_dir(&db).unwrap();
        let error = command(&f, &journal, AFTER, request.clone()).unwrap_err();
        let nonce = error
            .as_str()
            .unwrap()
            .strip_prefix("recovery_required:")
            .unwrap()
            .to_owned();
        assert_eq!(state(&f), (11, 5, 7));
        assert_eq!(receipt_count(&f), 0);
        assert!(!pending(&f).exists());
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BEFORE.as_bytes());
        fs::remove_dir(&db).unwrap();
        fs::rename(&saved, &db).unwrap();
        let invoke = || {
            crate::save_note_with_editor_journal(
                Ok(&journal),
                crate::NoteSaveInput {
                    vault: f.root.to_string_lossy().into_owned(),
                    path: "page.md".into(),
                    body: AFTER.into(),
                    expect_hash: None,
                    body_format: Some("source".into()),
                    recovery_bypass: Some(nonce.clone()),
                    editor_request: Some(request.clone()),
                },
            )
        };
        let result = invoke().unwrap();
        assert!(matches!(
            result,
            crate::NoteSaveResult::Selected(EditorSaveResult::Applied {
                recovery: Some(Outcome::WithoutCopy),
                ..
            })
        ));
        assert_eq!(receipt_count(&f), 1);
        assert_eq!(count_copies(&f, "pending"), 0);
        assert!(journal.enabled(&f.root).unwrap());
        assert!(invoke().is_err());
        assert_eq!(receipt_count(&f), 1);
    });
}

#[test]
fn editor_boundary_actual_applied_json_matches_its_generated_schema_fields() {
    let f = fixture("editor-wire-schema-fields");
    f.run(|| {
        let journal = journal(&f, false);
        let actual = command(&f, &journal, AFTER, fresh()).unwrap();
        let wire = serde_json::to_value(actual).unwrap();
        assert_eq!(wire["kind"], "selected_applied");
        assert!(wire.get("currentVersion").is_some());
        assert!(wire.get("reconcileRequired").is_some());
        assert!(wire.get("current_version").is_none());
        assert!(wire.get("reconcile_required").is_none());
        let schema = serde_json::to_value(schemars::schema_for!(EditorSaveResult)).unwrap();
        let variants = schema["oneOf"]
            .as_array()
            .or_else(|| schema["anyOf"].as_array())
            .unwrap();
        let properties = variants
            .iter()
            .find_map(|variant| {
                let properties = variant["properties"].as_object()?;
                (properties["kind"]["enum"]
                    .as_array()?
                    .iter()
                    .any(|kind| kind == "selected_applied"))
                .then_some(properties)
            })
            .unwrap();
        let schema_names: std::collections::BTreeSet<_> = properties.keys().collect();
        let actual_names: std::collections::BTreeSet<_> =
            wire.as_object().unwrap().keys().collect();
        assert_eq!(
            schema_names, actual_names,
            "the generated frontend contract must name the actual command fields"
        );
    });
}
