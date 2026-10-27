#![cfg(test)]
//! Actual guarded metadata kernel over disposable selected stores; no alternate mutation API.
use super::*;
use crate::workspace_service::selected::{
    self, MetadataPatchPhase, MetadataPatchRequest, MetadataPatchResult,
};
use crate::workspace_service::types::values::{PropertyChange, PropertyValue};
const TYPE_ID: &str = "f0af7737-ab3a-4754-9e12-91f0378ceaa0";
const KEY: &str = "30ebaf6d-dd57-476b-8c1c-19703d3905b3";
const KEY2: &str = "c00a4304-9ad1-438d-a156-f33a9a8ff951";
fn fixture(label: &str, schema4: bool) -> Fixture {
    let f = Fixture::new(&format!("metadata-request-{label}"));
    fs::remove_file(&f.db).unwrap();
    let conn = Connection::open(&f.db).unwrap();
    conn.execute_batch(if schema4 {
        include_str!("selected_schema_v4.sql")
    } else {
        include_str!("selected_schema_v3.sql")
    })
    .unwrap();
    conn.execute("INSERT INTO workspace VALUES (1,2,?1,5,11)", [WORKSPACE])
        .unwrap();
    let metadata = json!({"kind":"object","value":{
        "type":{"kind":"string","value":"Task"},"code":{"kind":"string","value":"before"},
        "nullable":{"kind":"string","value":"before"},"present":{"kind":"null"},
        "huge":{"kind":"decimal","value":"90071992547409931234567890.0001e+200"},
        "related":{"kind":"relation","spelling":"[[Self]]","fragment":null,"resolution":{"status":"resolved","targetId":RECORD}},
        "nested":{"kind":"object","value":{"keep":{"kind":"decimal","value":"-0.00000000000001"}}}
    }});
    conn.execute(
        "INSERT INTO records VALUES (?1,'page.md',7,?2,?3)",
        rusqlite::params![
            RECORD,
            crate::ledger::sha256_hex(BODY.as_bytes()),
            metadata.to_string()
        ],
    )
    .unwrap();
    let declaration = json!({"kind":"object","value":{"type":{"kind":"string","value":"Type"},"fields":{"kind":"object","value":{
        "code":{"kind":"string","value":"text"},"nullable":{"kind":"string","value":"text"},"present":{"kind":"string","value":"text"}
    }}}});
    conn.execute(
        "INSERT INTO records VALUES (?1,'task-type.md',1,?2,?3)",
        rusqlite::params![
            TYPE_ID,
            crate::ledger::sha256_hex(b"# Task\n"),
            declaration.to_string()
        ],
    )
    .unwrap();
    drop(conn);
    private_file(&f.db);
    fs::write(f.db.parent().unwrap().join("selected.lock"), []).unwrap();
    private_file(&f.db.parent().unwrap().join("selected.lock"));
    testutil::write(&f.root, "task-type.md", "# Task\n");
    f
}
fn set(key: &str, value: &str) -> PropertyChange {
    PropertyChange::Set {
        key: key.into(),
        value: PropertyValue::String {
            value: value.into(),
        },
    }
}
fn request(f: &Fixture) -> MetadataPatchRequest {
    MetadataPatchRequest {
        target: selected::SelectedEditorTarget {
            workspace_id: WORKSPACE.into(),
            record_id: RECORD.into(),
        },
        request_key: KEY.into(),
        expected_version: f.version(),
        changes: vec![set("code", "007")],
        phase: MetadataPatchPhase::Start,
        original: None,
    }
}
fn patch(
    f: &Fixture,
    request: &MetadataPatchRequest,
) -> Result<MetadataPatchResult, AuthorityError> {
    let by = crate::vault::receipt::WriteReceipt::ipc(
        crate::knowledge::guard_human_write("page.md").unwrap(),
    );
    selected::patch_metadata(&f.root, "page.md", request, &by)
}
fn counts(f: &Fixture) -> (i64, i64, i64, i64) {
    f.conn().query_row("SELECT metadata_epoch,(SELECT revision FROM records WHERE id=?1),(SELECT count(*) FROM metadata_receipts),(SELECT count(*) FROM metadata_requests) FROM workspace",[RECORD],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap()
}
fn applied(result: MetadataPatchResult) -> selected::MetadataPatchOperation {
    let MetadataPatchResult::Applied { operation, .. } = result else {
        panic!("actual metadata change requires applied receipt")
    };
    *operation
}
#[test]
fn actual_metadata_patch_uses_real_operation_and_preserves_unrelated_tags_and_exact_body() {
    let f = fixture("normal", true);
    f.run(|| {
        let before = f.version();
        let old = f.stored();
        let body = fs::read(f.root.join("page.md")).unwrap();
        let q = request(&f);
        let op = applied(patch(&f, &q).unwrap());
        assert_eq!(counts(&f), (12, 8, 1, 1));
        assert_eq!(op.target, q.target);
        assert_eq!(op.request_key, q.request_key);
        assert_eq!(op.version, f.version());
        assert_eq!(op.receipt.operation, "metadata.patch");
        assert_eq!(op.receipt.actor, "human:me");
        assert_eq!(op.receipt.previous_revision, "7");
        assert_eq!(op.receipt.revision, "8");
        assert_eq!(op.receipt.body_before_hash, before.body_hash);
        assert_eq!(op.receipt.body_after_hash, before.body_hash);
        let mut expected = old;
        expected["value"]["code"] = json!({"kind":"string","value":"007"});
        assert_eq!(f.stored(), expected);
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), body);
        assert_eq!(op.version.body_hash, before.body_hash);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), BODY);
    });
}
#[test]
fn tagged_null_and_remove_are_distinct_canonical_metadata_operations() {
    let f = fixture("null-remove", true);
    f.run(|| {
        let mut q = request(&f);
        q.changes = vec![PropertyChange::Set {
            key: "nullable".into(),
            value: PropertyValue::Null {},
        }];
        patch(&f, &q).unwrap();
        assert_eq!(f.stored()["value"]["nullable"], json!({"kind":"null"}));
        q.request_key = KEY2.into();
        q.expected_version = f.version();
        q.changes = vec![PropertyChange::Remove {
            key: "nullable".into(),
        }];
        patch(&f, &q).unwrap();
        assert!(f.stored()["value"].get("nullable").is_none());
        assert_eq!(counts(&f), (13, 9, 2, 2));
    });
}
#[test]
fn unchanged_request_is_durable_without_fabricating_receipt_revision_or_epoch() {
    let f = fixture("unchanged", true);
    f.run(||{
        let mut q=request(&f);q.changes=vec![set("code","before")];let expected=q.expected_version.clone();
        assert!(matches!(patch(&f,&q).unwrap(),MetadataPatchResult::Unchanged{version,..} if version==expected));assert_eq!(counts(&f),(11,7,0,1));
        q.phase=MetadataPatchPhase::Resolve;assert!(matches!(patch(&f,&q).unwrap(),MetadataPatchResult::Unchanged{version,..} if version==expected));assert_eq!(counts(&f),(11,7,0,1));
    });
}
#[test]
fn original_start_replay_after_new_metadata_returns_original_receipt_and_current_version() {
    let f = fixture("original-replay", true);
    f.run(||{
        let q=request(&f);let original=applied(patch(&f,&q).unwrap());
        let mut later=request(&f);later.request_key=KEY2.into();later.changes=vec![set("code","later")];patch(&f,&later).unwrap();
        let replay=patch(&f,&q).unwrap();assert!(matches!(replay,MetadataPatchResult::Applied{operation,current_version,reconcile_required:true} if *operation==original && current_version==f.version()));
        assert_eq!(counts(&f),(13,9,2,2));assert_eq!(f.stored()["value"]["code"]["value"],"later");
    });
}
#[test]
fn lost_commit_reply_resolves_original_request_without_a_second_patch() {
    let f = fixture("lost-reply", true);
    f.run(|| {
        let mut q = request(&f);
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            selected::with_after_commit_for_test(
                || panic!("simulated lost native reply after commit"),
                || patch(&f, &q),
            )
        }));
        assert!(stopped.is_err(), "actual postcommit hook must be reached");
        assert_eq!(counts(&f), (12, 8, 1, 1));
        q.phase = MetadataPatchPhase::Resolve;
        let op = applied(patch(&f, &q).unwrap());
        assert_eq!(op.request_key, KEY);
        assert_eq!(counts(&f), (12, 8, 1, 1));
    });
}
#[test]
fn unknown_resolve_never_applies_fresh_changes() {
    let f = fixture("missing-original", true);
    f.run(||{
        let mut q=request(&f);q.phase=MetadataPatchPhase::Resolve;let before=f.stored();
        assert!(matches!(patch(&f,&q).unwrap(),MetadataPatchResult::OutcomeUnknown{request_key,..} if request_key==KEY));
        assert_eq!(f.stored(),before);assert_eq!(counts(&f),(11,7,0,0));
    });
}
#[test]
fn reused_request_key_with_changed_payload_is_refused_not_a_second_write() {
    let f = fixture("key-payload", true);
    f.run(|| {
        let mut q = request(&f);
        patch(&f, &q).unwrap();
        q.changes = vec![set("code", "foreign")];
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::WrongIdentity
        );
        assert_eq!(counts(&f), (12, 8, 1, 1));
        assert_eq!(f.stored()["value"]["code"]["value"], "007");
    });
}
#[test]
fn supplied_original_receipt_cannot_replace_the_durable_original_result() {
    let f = fixture("foreign-original", true);
    f.run(|| {
        let mut q = request(&f);
        let mut original = applied(patch(&f, &q).unwrap());
        original.receipt.metadata_after_hash = "0".repeat(64);
        q.original = Some(Box::new(original));
        q.phase = MetadataPatchPhase::Resolve;
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::WrongIdentity
        );
        assert_eq!(counts(&f), (12, 8, 1, 1));
    });
}
#[test]
fn complete_cas_rejects_metadata_only_interleave_before_request_evidence() {
    let f = fixture("metadata-stale", true);
    f.run(|| {
        let q = request(&f);
        let mut changed = f.stored();
        changed["value"]["present"] = json!({"kind":"string","value":"changed"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1,revision=8 WHERE id=?2",
                rusqlite::params![changed.to_string(), RECORD],
            )
            .unwrap();
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::StaleMetadata
        );
        assert_eq!(counts(&f), (11, 8, 0, 0));
        assert_eq!(f.stored(), changed);
    });
}
#[test]
fn wrong_original_record_identity_is_refused_before_mutation() {
    let f = fixture("wrong-id", true);
    f.run(|| {
        let mut q = request(&f);
        q.target.record_id = TYPE_ID.into();
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::WrongIdentity
        );
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn external_body_change_cannot_be_blessed_by_a_metadata_patch() {
    let f = fixture("body-stale", true);
    f.run(|| {
        let q = request(&f);
        fs::write(f.root.join("page.md"), b"# Outside\n").unwrap();
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::SourceChanged
        );
        assert_eq!(counts(&f), (11, 7, 0, 0));
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), b"# Outside\n");
    });
}
#[test]
fn body_replacement_at_actual_precommit_hook_rolls_back_all_metadata_evidence() {
    let f = fixture("body-precommit", true);
    f.run(|| {
        let q = request(&f);
        let path = f.root.join("page.md");
        let old = f.stored();
        let result = selected::with_before_commit_for_test(
            move || fs::write(path, b"# Outside during metadata transaction\n").unwrap(),
            || patch(&f, &q),
        );
        assert_eq!(result.unwrap_err().kind, AuthorityErrorKind::SourceChanged);
        assert_eq!(f.stored(), old);
        assert_eq!(counts(&f), (11, 7, 0, 0));
        assert_eq!(
            fs::read(f.root.join("page.md")).unwrap(),
            b"# Outside during metadata transaction\n"
        );
    });
}
#[test]
fn canonical_governed_type_refuses_the_general_metadata_writer() {
    let f = fixture("governed", true);
    f.run(|| {
        let mut m = f.stored();
        m["value"]["type"] = json!({"kind":"string","value":"Agent"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![m.to_string(), RECORD],
            )
            .unwrap();
        assert_eq!(
            patch(&f, &request(&f)).unwrap_err().kind,
            AuthorityErrorKind::UnsupportedOperation
        );
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn provenance_stamp_keys_cannot_be_removed_by_the_general_patch() {
    let f = fixture("stamp", true);
    f.run(|| {
        let mut q = request(&f);
        q.changes = vec![PropertyChange::Remove {
            key: "source_system".into(),
        }];
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::UnsupportedOperation
        );
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn duplicate_patch_keys_are_rejected_before_any_evidence() {
    let f = fixture("duplicate-key", true);
    f.run(|| {
        let mut q = request(&f);
        q.changes.push(set("code", "second"));
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::InvalidMetadata
        );
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn oversized_tagged_value_is_refused_before_metadata_or_request_rows() {
    let f = fixture("value-limit", true);
    f.run(|| {
        let mut q = request(&f);
        q.changes = vec![set("code", &"x".repeat(70_000))];
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::SourceLimit
        );
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn schema4_requires_the_existing_original_workspace_lock() {
    let f = fixture("missing-lock", true);
    f.run(|| {
        fs::remove_file(f.db.parent().unwrap().join("selected.lock")).unwrap();
        assert_eq!(
            patch(&f, &request(&f)).unwrap_err().kind,
            AuthorityErrorKind::MetadataUnavailable
        );
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn schema3_is_not_implicitly_upgraded_and_keeps_its_existing_full_width_writer() {
    let f = fixture("old-schema", false);
    f.run(|| {
        let q = request(&f);
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::UnsupportedFormat
        );
        assert_eq!(
            f.conn()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), BODY);
        mutate(&f, f.version(), SelectedMode::Wide).unwrap();
        assert_eq!(
            f.stored()["value"]["huge"]["value"],
            "90071992547409931234567890.0001e+200"
        );
        assert_eq!(
            f.conn()
                .query_row("SELECT count(*) FROM metadata_receipts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    });
}
#[test]
fn complete_offline_snapshot_accepts_and_validates_original_request_evidence() {
    let f = fixture("offline-evidence", true);
    f.run(|| {
        patch(&f, &request(&f)).unwrap();
        let bytes = fs::read(&f.db).unwrap();
        let facts = selected::backup::read_offline(&bytes, WORKSPACE, 64 * 1024 * 1024).unwrap();
        assert_eq!(facts.schema_version, 4);
        assert_eq!(facts.epoch, 12);
        f.conn()
            .execute(
                "UPDATE metadata_requests SET result_metadata_hash=?1",
                ["0".repeat(64)],
            )
            .unwrap();
        let invalid = fs::read(&f.db).unwrap();
        assert_eq!(
            selected::backup::read_offline(&invalid, WORKSPACE, 64 * 1024 * 1024)
                .unwrap_err()
                .kind,
            AuthorityErrorKind::InvalidMetadata
        );
    });
}
#[test]
fn metadata_request_wire_is_closed_camel_case_and_keeps_exact_tagged_literals() {
    let f = fixture("wire", true);
    let q = request(&f);
    let raw = serde_json::to_value(&q).unwrap();
    assert_eq!(raw["requestKey"], KEY);
    assert!(raw.get("request_key").is_none());
    assert_eq!(
        raw["changes"][0]["value"],
        json!({"kind":"string","value":"007"})
    );
    let mut unknown = raw.clone();
    unknown["permission"] = json!(true);
    assert!(serde_json::from_value::<MetadataPatchRequest>(unknown).is_err());
    let schema = serde_json::to_value(schemars::schema_for!(MetadataPatchRequest)).unwrap();
    assert!(schema["properties"].get("expectedVersion").is_some());
    assert!(schema["properties"].get("requestKey").is_some());
    assert_eq!(
        serde_json::from_value::<MetadataPatchRequest>(raw).unwrap(),
        q
    );
}

#[test]
fn original_schema3_pending_intent_is_never_recovered_under_schema4() {
    let f = fixture("cross-schema-original", false);
    f.run(||{
        let by=crate::vault::receipt::WriteReceipt::ipc(crate::knowledge::guard_human_write("page.md").unwrap());
        let version=f.version();let after=b"# Original body save\n";
        let stopped=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||selected::with_after_commit_for_test(||panic!("stop original body writer before evidence retirement"),||selected::replace_body(&f.root,"page.md",&version,after,&by))));
        assert!(stopped.is_err());
        let intent=f.db.parent().unwrap().join("pending-change/intent.json");let original=fs::read(&intent).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&original).unwrap()["selected_schema"],3);
        // Adversarial disposable staging only: an admitted upgrade must itself
        // refuse pending evidence. Simulate bypass so recovery must still bind
        // this exact original envelope to its historical schema, on same inode.
        let sql=include_str!("selected_schema_v4.sql");
        let table=|name:&str|sql.split(';').map(str::trim).find(|s|s.starts_with(&format!("CREATE TABLE {name} ("))).unwrap();
        let upgrade=format!("BEGIN IMMEDIATE; ALTER TABLE metadata_receipts RENAME TO old_receipts; {}; INSERT INTO metadata_receipts SELECT * FROM old_receipts; DROP TABLE old_receipts; {}; PRAGMA user_version=4; COMMIT;",table("metadata_receipts"),table("metadata_requests"));
        f.conn().execute_batch(&upgrade).unwrap();
        assert_eq!(selected::recover_workspace(&f.root).unwrap_err().kind,AuthorityErrorKind::RecoveryConflict);
        assert_eq!(fs::read(&intent).unwrap(),original);assert_eq!(fs::read(f.root.join("page.md")).unwrap(),after);
        assert_eq!(counts(&f),(12,8,1,0));
    });
}

#[test]
fn original_unchanged_reply_reports_later_current_version_without_an_invented_receipt() {
    let f = fixture("unchanged-later", true);
    f.run(||{
        let mut original=request(&f);original.changes=vec![set("code","before")];let before=original.expected_version.clone();
        assert!(matches!(patch(&f,&original).unwrap(),MetadataPatchResult::Unchanged{..}));
        let mut later=request(&f);later.request_key=KEY2.into();later.changes=vec![set("code","later")];patch(&f,&later).unwrap();
        original.phase=MetadataPatchPhase::Resolve;
        assert!(matches!(patch(&f,&original).unwrap(),MetadataPatchResult::Unchanged{version,current_version,reconcile_required:true,..} if version==before && current_version==f.version()));
        assert_eq!(counts(&f),(12,8,1,2));assert_eq!(f.stored()["value"]["code"]["value"],"later");
    });
}

#[test]
fn type_declaration_body_change_before_metadata_commit_refuses_without_rechoosing_authority() {
    let f = fixture("type-precommit", true);
    f.run(|| {
        let q = request(&f);
        let before = f.stored();
        let declaration = f.root.join("task-type.md");
        let result = selected::with_before_commit_for_test(
            move || fs::write(declaration, b"# A different database\n").unwrap(),
            || patch(&f, &q),
        );
        assert_eq!(result.unwrap_err().kind, AuthorityErrorKind::SourceChanged);
        assert_eq!(f.stored(), before);
        assert_eq!(counts(&f), (11, 7, 0, 0));
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
        assert_eq!(
            fs::read(f.root.join("task-type.md")).unwrap(),
            b"# A different database\n"
        );
    });
}

#[test]
fn nonchosen_type_body_cannot_become_a_duplicate_declaration_before_commit() {
    let f = fixture("unchosen-type-precommit", true);
    f.run(|| {
        let second = "4ad8d7cf-07ef-4f24-a40e-f0ac76d983fb";
        let decl = json!({"kind":"object","value":{"type":{"kind":"string","value":"Type"}}});
        f.conn()
            .execute(
                "INSERT INTO records VALUES (?1,'other-type.md',1,?2,?3)",
                rusqlite::params![
                    second,
                    crate::ledger::sha256_hex(b"# Other\n"),
                    decl.to_string()
                ],
            )
            .unwrap();
        fs::write(f.root.join("other-type.md"), b"# Other\n").unwrap();
        let q = request(&f);
        let before = f.stored();
        let path = f.root.join("other-type.md");
        let result = selected::with_before_commit_for_test(
            move || fs::write(path, b"# Task\n").unwrap(),
            || patch(&f, &q),
        );
        assert_eq!(result.unwrap_err().kind, AuthorityErrorKind::SourceChanged);
        assert_eq!(f.stored(), before);
        assert_eq!(counts(&f), (11, 7, 0, 0));
        assert_eq!(fs::read(f.root.join("task-type.md")).unwrap(), b"# Task\n");
        assert_eq!(fs::read(f.root.join("other-type.md")).unwrap(), b"# Task\n");
    });
}
#[test]
fn bounded_original_request_rows_refuse_new_patch_without_retiring_prior_evidence() {
    let f = fixture("history-rows", true);
    f.run(|| {
        selected::with_metadata_request_bounds_for_test(2, 1_000_000, || {
            let mut q = request(&f);
            q.changes = vec![set("code", "before")];
            patch(&f, &q).unwrap();
            q.request_key = KEY2.into();
            patch(&f, &q).unwrap();
            assert_eq!(counts(&f), (11, 7, 0, 2));
            let before = f.stored();
            let mut third = request(&f);
            third.request_key = "2f8e1dd3-bd6d-459f-a9d2-8baf6e7c3ba5".into();
            assert_eq!(
                patch(&f, &third).unwrap_err().kind,
                AuthorityErrorKind::SourceLimit
            );
            assert_eq!(counts(&f), (11, 7, 0, 2));
            assert_eq!(f.stored(), before);
            q.phase = MetadataPatchPhase::Resolve;
            assert!(matches!(
                patch(&f, &q).unwrap(),
                MetadataPatchResult::Unchanged { .. }
            ));
            assert_eq!(counts(&f), (11, 7, 0, 2));
        })
    });
}
#[test]
fn bounded_original_request_bytes_refuse_before_committing_first_noop_evidence() {
    let f = fixture("history-bytes", true);
    f.run(|| {
        selected::with_metadata_request_bounds_for_test(10, 1, || {
            let mut q = request(&f);
            q.changes = vec![set("code", "before")];
            let before = f.stored();
            assert_eq!(
                patch(&f, &q).unwrap_err().kind,
                AuthorityErrorKind::SourceLimit
            );
            assert_eq!(counts(&f), (11, 7, 0, 0));
            assert_eq!(f.stored(), before);
        })
    });
}
#[test]
fn original_request_path_is_historical_evidence_and_current_path_divergence_reconciles() {
    let f = fixture("historical-path", true);
    f.run(||{
        let mut q=request(&f);let original=applied(patch(&f,&q).unwrap());
        // Disposable future-adoption probe only: no selected rename command is
        // introduced. Preserve the historical request path and record identity.
        f.conn().execute("UPDATE records SET path='moved.md' WHERE id=?1",[RECORD]).unwrap();fs::rename(f.root.join("page.md"),f.root.join("moved.md")).unwrap();
        q.phase=MetadataPatchPhase::Resolve;q.original=Some(Box::new(original.clone()));
        assert!(matches!(patch(&f,&q).unwrap(),MetadataPatchResult::Applied{operation,current_version,reconcile_required:true} if *operation==original && current_version==f.version()));
        let historical:String=f.conn().query_row("SELECT path FROM metadata_requests WHERE request_key=?1",[KEY],|r|r.get(0)).unwrap();assert_eq!(historical,"page.md");assert_eq!(counts(&f),(12,8,1,1));
        assert_eq!(fs::read(f.root.join("moved.md")).unwrap(),BODY.as_bytes());assert!(!f.root.join("page.md").exists());
    });
}

fn field_snapshot(
    f: &Fixture,
    key: &str,
) -> Result<selected::SelectedPropertySnapshot, AuthorityError> {
    selected::read_property(
        &f.root,
        "page.md",
        &selected::SelectedEditorTarget {
            workspace_id: WORKSPACE.into(),
            record_id: RECORD.into(),
        },
        key,
    )
}
#[test]
fn requested_field_read_keeps_literal_text_without_legacy_projection_of_unrelated_giant_values() {
    let f = fixture("field-read-exact", true);
    f.run(|| {
        let before = fs::read(&f.db).unwrap();
        let value = field_snapshot(&f, "code").unwrap();
        assert_eq!(value.target.record_id, RECORD);
        assert_eq!(value.path, "page.md");
        assert_eq!(value.field, "code");
        assert_eq!(value.version, f.version());
        assert_eq!(
            value.value,
            selected::SelectedPropertyValue::Present {
                value: PropertyValue::String {
                    value: "before".into()
                }
            }
        );
        assert!(value.editable);
        assert!(value.read_only_reason.is_none());
        assert_eq!(value.coherence, selected::EditorBodyCoherence::Paired);
        assert_eq!(
            value.observed_body_hash,
            crate::ledger::sha256_hex(BODY.as_bytes())
        );
        assert_eq!(fs::read(&f.db).unwrap(), before);
        assert_eq!(counts(&f), (11, 7, 0, 0));
        assert_eq!(
            f.stored()["value"]["huge"]["value"],
            "90071992547409931234567890.0001e+200"
        );
    });
}
#[test]
fn requested_field_read_distinguishes_absent_from_present_tagged_null() {
    let f = fixture("field-read-null", true);
    f.run(|| {
        let mut m = f.stored();
        m["value"].as_object_mut().unwrap().remove("nullable");
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![m.to_string(), RECORD],
            )
            .unwrap();
        assert_eq!(
            field_snapshot(&f, "nullable").unwrap().value,
            selected::SelectedPropertyValue::Absent {}
        );
        assert_eq!(
            field_snapshot(&f, "present").unwrap().value,
            selected::SelectedPropertyValue::Present {
                value: PropertyValue::Null {}
            }
        );
    });
}
#[test]
fn requested_field_read_returns_structural_value_tag_without_stringifying_or_rewriting_it() {
    let f = fixture("field-read-structure", true);
    f.run(||{
        let mut m=f.stored();m["value"]["code"]=json!({"kind":"object","value":{"literal":{"kind":"string","value":"007"},"large":{"kind":"decimal","value":"9007199254740993.125"}}});f.conn().execute("UPDATE records SET metadata=?1 WHERE id=?2",rusqlite::params![m.to_string(),RECORD]).unwrap();
        let state=field_snapshot(&f,"code").unwrap();assert!(!state.editable);assert!(state.read_only_reason.as_ref().is_some_and(|reason|!reason.is_empty()));let selected::SelectedPropertyValue::Present{value}=state.value else{panic!("stored structure is present")};assert_eq!(serde_json::to_value(value).unwrap(),m["value"]["code"]);assert_eq!(f.stored(),m);assert_eq!(counts(&f),(11,7,0,0));
    });
}
#[test]
fn requested_field_read_uses_same_native_provenance_refusal_even_when_type_declares_text() {
    let f = fixture("field-read-protected", true);
    f.run(|| {
        let mut m = f.stored();
        m["value"]["source_system"] = json!({"kind":"string","value":"notion"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![m.to_string(), RECORD],
            )
            .unwrap();
        let raw: String = f
            .conn()
            .query_row("SELECT metadata FROM records WHERE id=?1", [TYPE_ID], |r| {
                r.get(0)
            })
            .unwrap();
        let mut schema: Value = serde_json::from_str(&raw).unwrap();
        schema["value"]["fields"]["value"]["source_system"] =
            json!({"kind":"string","value":"text"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![schema.to_string(), TYPE_ID],
            )
            .unwrap();
        let state = field_snapshot(&f, "source_system").unwrap();
        assert!(!state.editable);
        assert!(state
            .read_only_reason
            .is_some_and(|reason| !reason.is_empty()));
        assert_eq!(
            state.value,
            selected::SelectedPropertyValue::Present {
                value: PropertyValue::String {
                    value: "notion".into()
                }
            }
        );
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn requested_field_read_keeps_governed_page_value_but_does_not_offer_general_text_edit() {
    let f = fixture("field-read-governed", true);
    f.run(|| {
        let mut m = f.stored();
        m["value"]["type"] = json!({"kind":"string","value":"Agent"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![m.to_string(), RECORD],
            )
            .unwrap();
        let state = field_snapshot(&f, "code").unwrap();
        assert!(!state.editable);
        assert!(state
            .read_only_reason
            .is_some_and(|reason| !reason.is_empty()));
        assert_eq!(
            state.value,
            selected::SelectedPropertyValue::Present {
                value: PropertyValue::String {
                    value: "before".into()
                }
            }
        );
    });
}
#[test]
fn requested_field_read_observes_external_body_bytes_without_rebasing_canonical_whole_version() {
    let f = fixture("field-read-external", true);
    f.run(|| {
        let version = f.version();
        fs::write(f.root.join("page.md"), b"# External exact bytes\r\n").unwrap();
        let state = field_snapshot(&f, "code").unwrap();
        assert_eq!(state.version, version);
        assert_eq!(
            state.coherence,
            selected::EditorBodyCoherence::ExternalChange
        );
        assert_eq!(
            state.observed_body_hash,
            crate::ledger::sha256_hex(b"# External exact bytes\r\n")
        );
        assert!(!state.editable);
        assert!(state
            .read_only_reason
            .is_some_and(|reason| !reason.is_empty()));
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn requested_field_read_default_denies_undeclared_field_without_inventing_a_value() {
    let f = fixture("field-read-undeclared", true);
    f.run(|| {
        let state = field_snapshot(&f, "not_declared").unwrap();
        assert_eq!(state.value, selected::SelectedPropertyValue::Absent {});
        assert!(!state.editable);
        assert!(state
            .read_only_reason
            .is_some_and(|reason| !reason.is_empty()));
    });
}
#[test]
fn requested_field_read_admits_number_without_rounding_exact_decimal() {
    let f = fixture("field-read-number", true);
    f.run(|| {
        let raw: String = f
            .conn()
            .query_row("SELECT metadata FROM records WHERE id=?1", [TYPE_ID], |r| {
                r.get(0)
            })
            .unwrap();
        let mut schema: Value = serde_json::from_str(&raw).unwrap();
        schema["value"]["fields"]["value"]["huge"] = json!({"kind":"string","value":"number"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                rusqlite::params![schema.to_string(), TYPE_ID],
            )
            .unwrap();
        let state = field_snapshot(&f, "huge").unwrap();
        assert_eq!(
            state.value,
            selected::SelectedPropertyValue::Present {
                value: PropertyValue::Decimal {
                    value: "90071992547409931234567890.0001e+200".into()
                }
            }
        );
        assert!(state.editable);
        assert!(state.read_only_reason.is_none());
    });
}
#[test]
fn requested_field_read_denies_ambiguous_type_authority_instead_of_choosing_first_doc() {
    let f = fixture("field-read-ambiguous", true);
    f.run(|| {
        f.conn()
            .execute(
                "INSERT INTO records VALUES (?1,'second-task.md',1,?2,?3)",
                rusqlite::params![
                    "f99a388b-9ca1-4217-b861-d0006ea6c22d",
                    crate::ledger::sha256_hex(b"# Task\n"),
                    json!({"kind":"object","value":{"type":{"kind":"string","value":"Type"}}})
                        .to_string()
                ],
            )
            .unwrap();
        fs::write(f.root.join("second-task.md"), b"# Task\n").unwrap();
        let state = field_snapshot(&f, "code").unwrap();
        assert!(!state.editable);
        assert!(state
            .read_only_reason
            .is_some_and(|reason| !reason.is_empty()));
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn requested_field_read_checks_original_native_record_target() {
    let f = fixture("field-read-wrong-id", true);
    f.run(|| {
        let error = selected::read_property(
            &f.root,
            "page.md",
            &selected::SelectedEditorTarget {
                workspace_id: WORKSPACE.into(),
                record_id: TYPE_ID.into(),
            },
            "code",
        )
        .unwrap_err();
        assert_eq!(error.kind, AuthorityErrorKind::WrongIdentity);
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn requested_field_read_is_fresh_when_only_independent_metadata_changes() {
    let f = fixture("field-read-metadata-change", true);
    f.run(|| {
        let first = field_snapshot(&f, "code").unwrap();
        let mut m = f.stored();
        m["value"]["code"] = json!({"kind":"string","value":"later literal 007"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1,revision=8 WHERE id=?2",
                rusqlite::params![m.to_string(), RECORD],
            )
            .unwrap();
        let next = field_snapshot(&f, "code").unwrap();
        assert_ne!(next.version.metadata_hash, first.version.metadata_hash);
        assert_eq!(next.version.metadata_revision, "8");
        assert_eq!(next.version.body_hash, first.version.body_hash);
        assert_eq!(
            next.value,
            selected::SelectedPropertyValue::Present {
                value: PropertyValue::String {
                    value: "later literal 007".into()
                }
            }
        );
    });
}
#[test]
fn selected_property_wire_has_explicit_absence_closed_values_and_native_refusal_tag() {
    assert_eq!(
        serde_json::to_value(selected::SelectedPropertyValue::Absent {}).unwrap(),
        json!({"kind":"absent"})
    );
    assert_eq!(
        serde_json::to_value(selected::SelectedPropertyValue::Present {
            value: PropertyValue::Null {}
        })
        .unwrap(),
        json!({"kind":"present","value":{"kind":"null"}})
    );
    assert!(serde_json::from_value::<selected::SelectedPropertyValue>(
        json!({"kind":"absent","value":null})
    )
    .is_err());
    let schema =
        serde_json::to_value(schemars::schema_for!(selected::SelectedPropertySnapshot)).unwrap();
    assert!(schema["properties"].get("observedBodyHash").is_some());
    assert!(schema["properties"].get("readOnlyReason").is_some());
    assert!(schema["properties"].get("observed_body_hash").is_none());
    let refusal = selected::MetadataPatchRefusal::MetadataRefused {
        error: authority::error(
            AuthorityErrorKind::UnsupportedOperation,
            "Native metadata operation unavailable.",
        ),
    };
    assert_eq!(
        serde_json::to_value(refusal).unwrap()["kind"],
        "metadata_refused"
    );
}

// Shared scalar transport/field-family cases: the same actual selected store
// and request kernel used above; no alternate Boolean writer or fixture API.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScalarCase {
    id: String,
    field_kind: String,
    stored: Option<PropertyValue>,
    change: PropertyChange,
    outcome: String,
    editable: bool,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScalarCases {
    version: u32,
    policy: String,
    field_kinds: String,
    cases: Vec<ScalarCase>,
}
fn scalar_case(id: &str) -> ScalarCase {
    let mut cases: ScalarCases = serde_json::from_str(include_str!(
        "../../../shared/workspace/metadata-scalar-cases.v1.json"
    ))
    .unwrap();
    assert_eq!(cases.version, 1);
    assert_eq!(cases.policy, "shared/workspace/metadata-patch.v1.json");
    assert_eq!(cases.field_kinds, "shared/schema/field-kinds.v1.json");
    let at = cases
        .cases
        .iter()
        .position(|case| case.id == id)
        .expect("shared scalar case");
    cases.cases.remove(at)
}
fn scalar_fixture(id: &str) -> (Fixture, ScalarCase) {
    let case = scalar_case(id);
    let f = fixture(&format!("scalar-{id}"), true);
    let mut value = f.stored();
    match &case.stored {
        Some(stored) => {
            value["value"]["flag"] = serde_json::to_value(stored).unwrap();
        }
        None => {
            value["value"].as_object_mut().unwrap().remove("flag");
        }
    }
    let conn = f.conn();
    conn.execute(
        "UPDATE records SET metadata=?1 WHERE id=?2",
        rusqlite::params![value.to_string(), RECORD],
    )
    .unwrap();
    let raw: String = conn
        .query_row(
            "SELECT metadata FROM records WHERE id=?1",
            [TYPE_ID],
            |row| row.get(0),
        )
        .unwrap();
    let mut declaration: serde_json::Value = serde_json::from_str(&raw).unwrap();
    declaration["value"]["fields"]["value"]["flag"] =
        json!({"kind":"string","value":case.field_kind.clone()});
    conn.execute(
        "UPDATE records SET metadata=?1 WHERE id=?2",
        rusqlite::params![declaration.to_string(), TYPE_ID],
    )
    .unwrap();
    drop(conn);
    (f, case)
}
fn scalar_request(f: &Fixture, case: &ScalarCase) -> MetadataPatchRequest {
    let mut q = request(f);
    q.changes = vec![case.change.clone()];
    q
}
fn replay_scalar(id: &str) {
    let (f, case) = scalar_fixture(id);
    f.run(||{
  let q=scalar_request(&f,&case);let before=f.stored();let body=fs::read(f.root.join("page.md")).unwrap();let result=patch(&f,&q);
  match case.outcome.as_str(){
   "applied"=>{let original=applied(result.unwrap());assert_eq!(original.receipt.operation,"metadata.patch");assert_eq!(counts(&f),(12,8,1,1));let mut expected=before.clone();match &case.change{PropertyChange::Set{key,value}=>{expected["value"][key]=serde_json::to_value(value).unwrap();},PropertyChange::Remove{key}=>{expected["value"].as_object_mut().unwrap().remove(key);}}assert_eq!(f.stored(),expected);let mut resolve=q.clone();resolve.phase=MetadataPatchPhase::Resolve;resolve.original=Some(Box::new(original.clone()));assert!(matches!(patch(&f,&resolve).unwrap(),MetadataPatchResult::Applied{operation,..} if *operation==original));assert_eq!(counts(&f),(12,8,1,1));},
   "unchanged"=>{assert!(matches!(result.unwrap(),MetadataPatchResult::Unchanged{version,..} if version==q.expected_version));assert_eq!(f.stored(),before);assert_eq!(counts(&f),(11,7,0,1));},
   "unsupported_projection"=>{assert_eq!(result.unwrap_err().kind,AuthorityErrorKind::UnsupportedProjection);assert_eq!(f.stored(),before);assert_eq!(counts(&f),(11,7,0,0));},
   _=>panic!("unsupported shared expected scalar result"),
  }
  assert_eq!(fs::read(f.root.join("page.md")).unwrap(),body);
 });
}
#[test]
fn checkbox_shared_true_to_false() {
    replay_scalar("true_to_false");
}
#[test]
fn checkbox_shared_false_to_true() {
    replay_scalar("false_to_true");
}
#[test]
fn checkbox_shared_absent_to_false() {
    replay_scalar("absent_to_false");
}
#[test]
fn checkbox_shared_null_to_false() {
    replay_scalar("null_to_false");
}
#[test]
fn checkbox_shared_boolean_to_null() {
    replay_scalar("boolean_to_null");
}
#[test]
fn checkbox_shared_remove_boolean() {
    replay_scalar("remove_boolean");
}
#[test]
fn checkbox_shared_unchanged_false() {
    replay_scalar("unchanged_false");
}
#[test]
fn checkbox_shared_string_is_not_boolean() {
    replay_scalar("string_is_not_boolean");
}
#[test]
fn checkbox_shared_decimal_is_not_boolean() {
    replay_scalar("decimal_is_not_boolean");
}
#[test]
fn checkbox_shared_boolean_is_not_text() {
    replay_scalar("boolean_is_not_text");
}
#[test]
fn checkbox_shared_stored_text_is_replaced_only_by_explicit_tag() {
    replay_scalar("stored_text_under_checkbox");
}
#[test]
fn checkbox_shared_stored_boolean_is_replaced_only_by_explicit_text() {
    replay_scalar("stored_boolean_under_text");
}
fn read_scalar_case(id: &str) {
    let (f, case) = scalar_fixture(id);
    f.run(|| {
        let q = scalar_request(&f, &case);
        let state = selected::read_property(&f.root, "page.md", &q.target, "flag").unwrap();
        assert_eq!(state.editable, case.editable);
        let expected = match case.stored {
            Some(value) => selected::SelectedPropertyValue::Present { value },
            None => selected::SelectedPropertyValue::Absent {},
        };
        assert_eq!(state.value, expected);
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn checkbox_read_returns_exact_boolean_and_editability() {
    read_scalar_case("true_to_false");
}
#[test]
fn checkbox_read_distinguishes_absence_from_false() {
    read_scalar_case("absent_to_false");
}
#[test]
fn checkbox_read_distinguishes_explicit_null() {
    read_scalar_case("null_to_false");
}
#[test]
fn checkbox_read_text_stays_typed_and_readonly() {
    read_scalar_case("stored_text_under_checkbox");
}
#[test]
fn checkbox_read_boolean_under_text_stays_readonly() {
    read_scalar_case("stored_boolean_under_text");
}
#[test]
fn checkbox_lost_reply_resolves_exact_original_without_second_toggle() {
    let (f, case) = scalar_fixture("true_to_false");
    f.run(|| {
        let mut q = scalar_request(&f, &case);
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            selected::with_after_commit_for_test(
                || panic!("simulated lost Boolean reply"),
                || patch(&f, &q),
            )
        }));
        assert!(
            stopped.is_err(),
            "actual Boolean commit hook must be reached"
        );
        assert_eq!(counts(&f), (12, 8, 1, 1));
        q.phase = MetadataPatchPhase::Resolve;
        applied(patch(&f, &q).unwrap());
        assert_eq!(counts(&f), (12, 8, 1, 1));
        assert_eq!(
            f.stored()["value"]["flag"],
            json!({"kind":"boolean","value":false})
        );
    });
}
#[test]
fn checkbox_metadata_interleave_refuses_original_whole_version() {
    let (f, case) = scalar_fixture("true_to_false");
    f.run(|| {
        let q = scalar_request(&f, &case);
        let mut changed = f.stored();
        changed["value"]["code"] = json!({"kind":"string","value":"later"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1,revision=8 WHERE id=?2",
                rusqlite::params![changed.to_string(), RECORD],
            )
            .unwrap();
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::StaleMetadata
        );
        assert_eq!(f.stored(), changed);
        assert_eq!(counts(&f), (11, 8, 0, 0));
    });
}
#[test]
fn checkbox_external_body_refuses_original_toggle() {
    let (f, case) = scalar_fixture("true_to_false");
    f.run(|| {
        let q = scalar_request(&f, &case);
        let before = f.stored();
        fs::write(f.root.join("page.md"), b"# Outside Boolean edit\n").unwrap();
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::SourceChanged
        );
        assert_eq!(f.stored(), before);
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn checkbox_type_body_precommit_change_rolls_back_all_original_rows() {
    let (f, case) = scalar_fixture("true_to_false");
    f.run(|| {
        let q = scalar_request(&f, &case);
        let before = f.stored();
        let declaration = f.root.join("task-type.md");
        let result = selected::with_before_commit_for_test(
            move || fs::write(declaration, b"# Renamed Type\n").unwrap(),
            || patch(&f, &q),
        );
        assert_eq!(result.unwrap_err().kind, AuthorityErrorKind::SourceChanged);
        assert_eq!(f.stored(), before);
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}

// Contact/link String families replay the same actual metadata kernel.
#[test]
fn contact_shared_email_literal() {
    replay_scalar("email_literal");
}
#[test]
fn contact_shared_phone_literal() {
    replay_scalar("phone_literal");
}
#[test]
fn contact_shared_url_literal() {
    replay_scalar("url_literal");
}
#[test]
fn contact_shared_email_explicit_null() {
    replay_scalar("email_explicit_null");
}
#[test]
fn contact_shared_phone_remove() {
    replay_scalar("phone_remove");
}
#[test]
fn contact_shared_url_unchanged() {
    replay_scalar("url_unchanged");
}
#[test]
fn contact_shared_url_invalid_prefix() {
    replay_scalar("url_invalid_prefix");
}
#[test]
fn contact_shared_url_missing_scheme_not_normalized() {
    replay_scalar("url_missing_scheme_not_normalized");
}
#[test]
fn contact_shared_email_boolean_refused() {
    replay_scalar("email_boolean_refused");
}
#[test]
fn contact_shared_phone_decimal_refused() {
    replay_scalar("phone_decimal_refused");
}
#[test]
fn contact_shared_url_wrong_stored_shape() {
    replay_scalar("url_wrong_stored_shape");
}
#[test]
fn contact_shared_email_empty_string_is_present() {
    replay_scalar("email_empty_string_is_present");
}
#[test]
fn contact_read_email_exact_string() {
    read_scalar_case("email_literal");
}
#[test]
fn contact_read_phone_exact_string() {
    read_scalar_case("phone_literal");
}
#[test]
fn contact_read_url_exact_string() {
    read_scalar_case("url_literal");
}
#[test]
fn contact_read_wrong_url_shape_stays_typed_readonly() {
    read_scalar_case("url_wrong_stored_shape");
}

// Exact Number authoring uses this same actual selected metadata kernel.
#[test]
fn number_large_fraction() {
    replay_scalar("number_large_fraction");
}
#[test]
fn number_negative_zero_spelling() {
    replay_scalar("number_negative_zero_spelling");
}
#[test]
fn number_huge_exponent() {
    replay_scalar("number_huge_exponent");
}
#[test]
fn number_tiny_exponent() {
    replay_scalar("number_tiny_exponent");
}
#[test]
fn number_absent_to_zero() {
    replay_scalar("number_absent_to_zero");
}
#[test]
fn number_null_to_negative_zero() {
    replay_scalar("number_null_to_negative_zero");
}
#[test]
fn number_explicit_null() {
    replay_scalar("number_explicit_null");
}
#[test]
fn number_remove() {
    replay_scalar("number_remove");
}
#[test]
fn number_unchanged_exact() {
    replay_scalar("number_unchanged_exact");
}
#[test]
fn number_numeric_equal_different_spelling() {
    replay_scalar("number_numeric_equal_different_spelling");
}
#[test]
fn number_string_not_decimal() {
    replay_scalar("number_string_not_decimal");
}
#[test]
fn number_boolean_not_decimal() {
    replay_scalar("number_boolean_not_decimal");
}
#[test]
fn number_decimal_not_text() {
    replay_scalar("number_decimal_not_text");
}
#[test]
fn number_stored_string_readonly() {
    replay_scalar("number_stored_string_readonly");
}
#[test]
fn number_read_exact_large_fraction() {
    read_scalar_case("number_large_fraction");
}
#[test]
fn number_read_absence_remains_distinct() {
    read_scalar_case("number_absent_to_zero");
}
#[test]
fn number_read_numeric_looking_string_stays_typed_readonly() {
    read_scalar_case("number_stored_string_readonly");
}
#[test]
fn number_lost_reply_resolves_original_exact_lexeme_without_second_mutation() {
    let (f, case) = scalar_fixture("number_negative_zero_spelling");
    f.run(|| {
        let mut q = scalar_request(&f, &case);
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            selected::with_after_commit_for_test(
                || panic!("simulated lost exact Number reply"),
                || patch(&f, &q),
            )
        }));
        assert!(
            stopped.is_err(),
            "actual Number commit hook must be reached"
        );
        assert_eq!(counts(&f), (12, 8, 1, 1));
        q.phase = MetadataPatchPhase::Resolve;
        let original = applied(patch(&f, &q).unwrap());
        assert_eq!(original.request_key, KEY);
        assert_eq!(counts(&f), (12, 8, 1, 1));
        assert_eq!(
            f.stored()["value"]["flag"],
            json!({"kind":"decimal","value":"-0.00E+03"})
        );
    });
}
#[test]
fn number_type_body_precommit_replacement_rolls_back_original_request_and_receipt() {
    let (f, case) = scalar_fixture("number_large_fraction");
    f.run(|| {
        let q = scalar_request(&f, &case);
        let before = f.stored();
        let declaration = f.root.join("task-type.md");
        let result = selected::with_before_commit_for_test(
            move || fs::write(declaration, b"# A different Type\n").unwrap(),
            || patch(&f, &q),
        );
        assert_eq!(result.unwrap_err().kind, AuthorityErrorKind::SourceChanged);
        assert_eq!(f.stored(), before);
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn number_invalid_lexemes_never_create_metadata_evidence() {
    for invalid in [
        "007", "+1", "1.", ".5", " 1", "1 ", "NaN", "Infinity", "1e", "",
    ] {
        let (f, case) = scalar_fixture("number_large_fraction");
        f.run(|| {
            let mut q = scalar_request(&f, &case);
            q.changes = vec![PropertyChange::Set {
                key: "flag".into(),
                value: PropertyValue::Decimal {
                    value: invalid.into(),
                },
            }];
            let before = f.stored();
            assert_eq!(
                patch(&f, &q).unwrap_err().kind,
                AuthorityErrorKind::InvalidMetadata,
                "invalid lexeme {invalid:?}"
            );
            assert_eq!(f.stored(), before);
            assert_eq!(counts(&f), (11, 7, 0, 0));
        });
    }
}
#[test]
fn number_metadata_interleave_refuses_original_exact_decimal_expectation() {
    let (f, case) = scalar_fixture("number_large_fraction");
    f.run(|| {
        let q = scalar_request(&f, &case);
        let mut changed = f.stored();
        changed["value"]["code"] = json!({"kind":"string","value":"later canonical metadata"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1,revision=8 WHERE id=?2",
                rusqlite::params![changed.to_string(), RECORD],
            )
            .unwrap();
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::StaleMetadata
        );
        assert_eq!(f.stored(), changed);
        assert_eq!(counts(&f), (11, 8, 0, 0));
    });
}

// Bounded calendar-day Date uses the actual selected metadata kernel.
#[test]
fn date_leap_day() {
    replay_scalar("date_leap_day");
}
#[test]
fn date_absent_to_day() {
    replay_scalar("date_absent_to_day");
}
#[test]
fn date_null_to_day() {
    replay_scalar("date_null_to_day");
}
#[test]
fn date_explicit_null() {
    replay_scalar("date_explicit_null");
}
#[test]
fn date_remove() {
    replay_scalar("date_remove");
}
#[test]
fn date_unchanged() {
    replay_scalar("date_unchanged");
}
#[test]
fn date_string_is_not_day() {
    replay_scalar("date_string_is_not_day");
}
#[test]
fn date_local_time_is_not_day() {
    replay_scalar("date_local_time_is_not_day");
}
#[test]
fn date_instant_is_not_day() {
    replay_scalar("date_instant_is_not_day");
}
#[test]
fn date_boolean_refused() {
    replay_scalar("date_boolean_refused");
}
#[test]
fn date_decimal_refused() {
    replay_scalar("date_decimal_refused");
}
#[test]
fn date_stored_string_readonly() {
    replay_scalar("date_stored_string_readonly");
}
#[test]
fn date_stored_instant_readonly() {
    replay_scalar("date_stored_instant_readonly");
}
#[test]
fn date_day_is_not_text() {
    replay_scalar("date_day_is_not_text");
}
#[test]
fn date_looking_text_stays_text() {
    replay_scalar("date_looking_text_stays_text");
}
#[test]
fn date_read_exact_calendar_day() {
    read_scalar_case("date_leap_day");
}
#[test]
fn date_read_null_distinct_from_absence() {
    read_scalar_case("date_null_to_day");
}
#[test]
fn date_read_date_looking_string_remains_typed_readonly() {
    read_scalar_case("date_stored_string_readonly");
}
#[test]
fn date_read_exact_instant_remains_typed_readonly() {
    read_scalar_case("date_stored_instant_readonly");
}
#[test]
fn date_lost_reply_resolves_original_calendar_day_without_second_mutation() {
    let (f, case) = scalar_fixture("date_leap_day");
    f.run(|| {
        let mut q = scalar_request(&f, &case);
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            selected::with_after_commit_for_test(
                || panic!("simulated lost calendar Date reply"),
                || patch(&f, &q),
            )
        }));
        assert!(stopped.is_err(), "actual Date commit hook must be reached");
        assert_eq!(counts(&f), (12, 8, 1, 1));
        q.phase = MetadataPatchPhase::Resolve;
        applied(patch(&f, &q).unwrap());
        assert_eq!(counts(&f), (12, 8, 1, 1));
        assert_eq!(
            f.stored()["value"]["flag"],
            json!({"kind":"date","value":"2028-02-29"})
        );
    });
}
#[test]
fn date_type_body_precommit_replacement_rolls_back_original_request_and_receipt() {
    let (f, case) = scalar_fixture("date_leap_day");
    f.run(|| {
        let q = scalar_request(&f, &case);
        let before = f.stored();
        let declaration = f.root.join("task-type.md");
        let result = selected::with_before_commit_for_test(
            move || fs::write(declaration, b"# Renamed calendar Type\n").unwrap(),
            || patch(&f, &q),
        );
        assert_eq!(result.unwrap_err().kind, AuthorityErrorKind::SourceChanged);
        assert_eq!(f.stored(), before);
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn date_invalid_calendar_or_non_day_tag_lexemes_never_create_request_evidence() {
    for invalid in [
        "2026-02-29",
        "1900-02-29",
        "2026-13-01",
        "2026-04-31",
        " 2024-02-29",
        "2024-02-29 ",
        "2026-10-23 12:00",
        "2026-10-23T12:00:00Z",
    ] {
        let (f, case) = scalar_fixture("date_leap_day");
        f.run(|| {
            let mut q = scalar_request(&f, &case);
            q.changes = vec![PropertyChange::Set {
                key: "flag".into(),
                value: PropertyValue::Date {
                    value: invalid.into(),
                },
            }];
            let before = f.stored();
            assert_eq!(
                patch(&f, &q).unwrap_err().kind,
                AuthorityErrorKind::InvalidMetadata,
                "invalid day {invalid:?}"
            );
            assert_eq!(f.stored(), before);
            assert_eq!(counts(&f), (11, 7, 0, 0));
        });
    }
}
#[test]
fn date_metadata_interleave_refuses_original_calendar_expectation() {
    let (f, case) = scalar_fixture("date_leap_day");
    f.run(|| {
        let q = scalar_request(&f, &case);
        let mut changed = f.stored();
        changed["value"]["code"] = json!({"kind":"string","value":"later canonical metadata"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1,revision=8 WHERE id=?2",
                rusqlite::params![changed.to_string(), RECORD],
            )
            .unwrap();
        assert_eq!(
            patch(&f, &q).unwrap_err().kind,
            AuthorityErrorKind::StaleMetadata
        );
        assert_eq!(f.stored(), changed);
        assert_eq!(counts(&f), (11, 8, 0, 0));
    });
}

// Actual native scan after acknowledged canonical metadata; no fake rescan.
fn projection_fixture(id: &str) -> (Fixture, ScalarCase) {
    let (f, case) = scalar_fixture(id);
    let mut metadata = f.stored();
    metadata["value"]
        .as_object_mut()
        .unwrap()
        .retain(|key, _| matches!(key.as_str(), "type" | "code" | "flag"));
    f.conn()
        .execute(
            "UPDATE records SET metadata=?1 WHERE id=?2",
            rusqlite::params![metadata.to_string(), RECORD],
        )
        .unwrap();
    (f, case)
}
fn production_scan(f: &Fixture) -> Vec<crate::vault::entry::Entry> {
    crate::scan_vault(f.root.to_string_lossy().into_owned()).unwrap()
}
#[test]
fn selected_scan_after_exact_number_keeps_known_ack_and_full_canonical_carrier() {
    let (f, case) = projection_fixture("number_negative_zero_spelling");
    f.run(|| {
        let before = production_scan(&f);
        assert_eq!(before.len(), 2);
        assert_eq!(
            before
                .iter()
                .find(|entry| entry.path == "page.md")
                .unwrap()
                .properties["flag"],
            json!(1)
        );
        let mut q = scalar_request(&f, &case);
        q.changes = vec![PropertyChange::Set {
            key: "flag".into(),
            value: PropertyValue::Decimal {
                value: "1e400".into(),
            },
        }];
        let original = applied(patch(&f, &q).unwrap());
        assert_eq!(counts(&f), (12, 8, 1, 1));
        let entry = production_scan(&f)
            .into_iter()
            .find(|entry| entry.path == "page.md")
            .unwrap();
        assert_eq!(entry.authority.as_ref(), Some(&original.version));
        let wire = serde_json::to_value(&entry).unwrap();
        assert_eq!(wire["canonicalProperties"]["value"], f.stored());
        assert_eq!(
            wire["canonicalProperties"]["value"]["value"]["flag"],
            json!({"kind":"decimal","value":"1e400"})
        );
        assert!(wire["canonicalProperties"]["unavailableLegacyKeys"]
            .as_array()
            .unwrap()
            .iter()
            .any(|key| key.as_str() == Some("flag")));
        assert_eq!(counts(&f), (12, 8, 1, 1));
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
    });
}
#[test]
fn selected_scan_after_calendar_date_preserves_tag_and_ack_version() {
    let (f, case) = projection_fixture("date_leap_day");
    f.run(|| {
        assert_eq!(production_scan(&f).len(), 2);
        let q = scalar_request(&f, &case);
        let original = applied(patch(&f, &q).unwrap());
        assert_eq!(counts(&f), (12, 8, 1, 1));
        let entry = production_scan(&f)
            .into_iter()
            .find(|entry| entry.path == "page.md")
            .unwrap();
        assert_eq!(entry.authority.as_ref(), Some(&original.version));
        let wire = serde_json::to_value(&entry).unwrap();
        assert_eq!(wire["canonicalProperties"]["value"], f.stored());
        assert_eq!(
            wire["canonicalProperties"]["value"]["value"]["flag"],
            json!({"kind":"date","value":"2028-02-29"})
        );
        assert_eq!(counts(&f), (12, 8, 1, 1));
    });
}
#[test]
fn selected_scan_retains_unrelated_large_decimals_relations_and_nested_presence() {
    let f = fixture("scan-carrier-unrelated", true);
    f.run(|| {
        let original = f.stored();
        let entry = production_scan(&f)
            .into_iter()
            .find(|entry| entry.path == "page.md")
            .unwrap();
        let wire = serde_json::to_value(&entry).unwrap();
        assert_eq!(wire["canonicalProperties"]["value"], original);
        let unavailable = wire["canonicalProperties"]["unavailableLegacyKeys"]
            .as_array()
            .unwrap();
        for key in ["huge", "related", "nested"] {
            assert!(
                unavailable.iter().any(|value| value.as_str() == Some(key)),
                "{key} cannot disappear as absent"
            );
        }
        assert_eq!(counts(&f), (11, 7, 0, 0));
    });
}
#[test]
fn selected_scan_retains_unprojectable_reserved_type_configuration_explicitly() {
    let (f, _) = projection_fixture("number_negative_zero_spelling");
    f.run(|| {
        let raw: String = f
            .conn()
            .query_row(
                "SELECT metadata FROM records WHERE id=?1",
                [TYPE_ID],
                |row| row.get(0),
            )
            .unwrap();
        let mut declaration: serde_json::Value = serde_json::from_str(&raw).unwrap();
        declaration["value"]["fields"]["value"]["diagnostic"] =
            json!({"kind":"decimal","value":"1e400"});
        f.conn()
            .execute(
                "UPDATE records SET metadata=?1,revision=2 WHERE id=?2",
                rusqlite::params![declaration.to_string(), TYPE_ID],
            )
            .unwrap();
        let entry = production_scan(&f)
            .into_iter()
            .find(|entry| entry.path == "task-type.md")
            .unwrap();
        assert_eq!(entry.entry_type.as_deref(), Some("Type"));
        let wire = serde_json::to_value(&entry).unwrap();
        assert_eq!(wire["canonicalProperties"]["value"], declaration);
        assert!(
            wire["canonicalProperties"]["unavailableLegacyKeys"]
                .as_array()
                .unwrap()
                .iter()
                .any(|key| key.as_str() == Some("fields")),
            "Type fields cannot become an empty/default declaration"
        );
    });
}
#[test]
fn selected_scan_malformed_canonical_type_is_not_reclassified_as_untyped() {
    let (f, _) = projection_fixture("number_negative_zero_spelling");
    f.run(||{let mut metadata=f.stored();metadata["value"]["type"]=json!({"kind":"decimal","value":"7"});f.conn().execute("UPDATE records SET metadata=?1 WHERE id=?2",rusqlite::params![metadata.to_string(),RECORD]).unwrap();
  assert!(matches!(crate::scan_vault(f.root.to_string_lossy().into_owned()),Err(crate::workspace_service::types::selected::CommandReadError::Authority(ref error)) if error.kind==AuthorityErrorKind::UnsupportedProjection));assert_eq!(counts(&f),(11,7,0,0));
 });
}

#[test]
#[ignore = "explicitly export real selected scan/property/request/ACK fixture after canonical carrier changes"]
fn export_selected_entry_projection_native_fixture() {
    fn presentation(entries: Vec<crate::vault::entry::Entry>) -> serde_json::Value {
        let mut value = serde_json::to_value(entries).unwrap();
        for entry in value.as_array_mut().unwrap() {
            // Only non-authoritative filesystem presentation timestamps are
            // sanitized. Authority versions, metadata/body hashes and original
            // request/receipt identities remain actual kernel output.
            entry["createdAt"] = json!("2000-01-01T00:00:00Z");
            entry["modifiedAt"] = json!("2000-01-01T00:00:00Z");
        }
        value
    }
    let mut samples = serde_json::Map::new();
    for (name, id, operation_id) in [
        (
            "number",
            "number_negative_zero_spelling",
            "8dbadc70-6318-4f8e-93ac-2f8a9c0d0001",
        ),
        (
            "date",
            "date_leap_day",
            "8dbadc70-6318-4f8e-93ac-2f8a9c0d0002",
        ),
    ] {
        let (f, case) = projection_fixture(id);
        let sample=f.run(||{
            let before=json!({"entries":presentation(production_scan(&f)),"field":field_snapshot(&f,"flag").unwrap()});
            let mut q=scalar_request(&f,&case);if name=="number"{q.changes=vec![PropertyChange::Set{key:"flag".into(),value:PropertyValue::Decimal{value:"1e400".into()}}];}
            let ack=selected::with_operation_stamp_for_test(operation_id,"2026-10-27T00:00:00+00:00",||patch(&f,&q)).unwrap();
            let MetadataPatchResult::Applied{operation,..}=&ack else{panic!("fixture must capture an actual native Applied")};
            assert_eq!(operation.operation_id,operation_id);assert_eq!(operation.receipt.at,"2026-10-27T00:00:00+00:00");assert_eq!(counts(&f),(12,8,1,1));
            let after=json!({"entries":presentation(production_scan(&f)),"field":field_snapshot(&f,"flag").unwrap()});
            let sample=json!({"request":q,"ack":ack,"before":before,"after":after});
            assert!(!serde_json::to_string(&sample).unwrap().contains(f.root.to_str().unwrap()),"no temporary or real vault path enters the fixture");sample
        });
        samples.insert(name.into(), sample);
    }
    let bundle = json!({"version":1,"scope":{"vault":"/test-only-selected-entry-projection","path":"page.md","field":"flag"},"provenance":"actual_disposable_native_scan_read_property_patch_request_ack","sanitizedPresentationFields":["Entry.createdAt","Entry.modifiedAt"],"originalStamp":"cfg(test) scoped at actual mint before native transaction, not rewritten after commit","samples":samples});
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../shared/workspace/selected-entry-projection-native.v1.json");
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&bundle).unwrap()),
    )
    .unwrap();
}

#[path = "selected_saved_view_tests.rs"]
mod saved_views;
