use super::*;
use crate::actions::effect_record;
const VAULT: &str = "cccccccccccccccccccccccccccccccc";
const RUN: &str = "original-run";
const STAMP: &str = "2026-10-26T00:00:00Z";
fn fixture() -> (Connection, ActionSubjectView) {
    let data = crate::vault::testutil::temp_vault("act-chat-retention");
    let conn = crate::runtime::open(&data).unwrap();
    conn.execute("INSERT INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,'/chat-retention-fixture',?2)",rusqlite::params![VAULT,STAMP]).unwrap();
    conn.execute("INSERT INTO app_sessions(session_id,vault_id,store_uuid,opened_at,last_heartbeat_at,close_precision) VALUES('archive-session',?1,'store',?2,?2,'open')",rusqlite::params![VAULT,STAMP]).unwrap();
    conn.execute("INSERT INTO runs(run_id,vault_id,store_uuid,mode,lane,started_at,outcome,usage_state,input_tokens,output_tokens,cache_read,cache_write,reserved_total_tokens,reserved_output_tokens,proposals_submitted,applied,rejected,actor,cli_session_id) VALUES(?1,?2,'store','attended',(SELECT lane FROM lane_registry LIMIT 1),?3,'running','pending',0,0,0,0,0,0,0,0,0,'human:me','12345678-1234-1234-1234-123456789abc')",rusqlite::params![RUN,VAULT,STAMP]).unwrap();
    conn.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,admitted_at) VALUES(?1,?2,1,?3,'store','/chat-retention-fixture','human:me','human:me','run','archive-session','12345678-1234-1234-1234-123456789abc',?4)",rusqlite::params![RUN,"a".repeat(32),VAULT,STAMP]).unwrap();
    let scope = ActionSubjectView {
        vault_id: VAULT.into(),
        run_id: RUN.into(),
        actor_id: "human:me".into(),
        child_job_id: None,
        client_id: None,
    };
    let value = effect_record::tests::fixture(&scope, 1);
    let key = effect_record::scope_key(&scope).unwrap();
    conn.execute("INSERT INTO action_invocations(invocation_id,subject_scope,request_key,request_digest,revision,state,payload) VALUES(?1,?2,?3,?4,1,'outcome_unknown',?5)",rusqlite::params![format!("{:032x}",1),key,value["request"]["requestKey"].as_str().unwrap(),value["request_digest"].as_str().unwrap(),value.to_string()]).unwrap();
    // IDs are the fixture's actual hexadecimal ordinal, not an invented key.
    (conn, scope)
}
#[test]
fn act_chat_retention_returns_opaque_original_effect_reference_without_payload() {
    let (conn, _) = fixture();
    assert_eq!(
        references(&conn, VAULT, "store", RUN, "human:me"),
        Ok(vec![format!("{:032x}", 1)])
    );
}
#[test]
fn act_chat_retention_live_unknown_owner_blocks_but_closed_unknown_evidence_survives() {
    let (conn, _) = fixture();
    assert_eq!(
        active_owners(&conn, VAULT, "store", RUN, "human:me"),
        Ok(vec![format!("{:032x}", 1)])
    );
    conn.execute(
        "UPDATE action_native_runs SET closed_at=?1,close_kind='completed' WHERE run_id=?2",
        rusqlite::params![STAMP, RUN],
    )
    .unwrap();
    assert_eq!(
        active_owners(&conn, VAULT, "store", RUN, "human:me"),
        Ok(Vec::new())
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM action_invocations", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn act_chat_retention_scope_mismatch_and_malformed_history_refuse_instead_of_empty() {
    let (conn, _) = fixture();
    assert!(references(&conn, VAULT, "wrong-store", RUN, "human:me").is_err());
    conn.execute_batch("PRAGMA ignore_check_constraints=ON;")
        .unwrap();
    conn.execute("UPDATE action_invocations SET payload='{}'", [])
        .unwrap();
    assert!(active_owners(&conn, VAULT, "store", RUN, "human:me").is_err());
}

#[test]
fn act_chat_retention_closed_dispatched_blocks_cache_copy_without_chat_session() {
    use crate::agent::archive_codec::{ArchiveTurnV1, Availability, Block};
    use crate::runtime::{chat_generations as generations, conversations as archive};
    use archive::legacy::{ImportBatch, ImportItem, ImportSkip, LegacyAttempt};
    let (conn, _) = fixture();
    let scope = generations::Scope {
        owner: "human:me",
        vault: VAULT,
        store: "store",
        actor: "human:me",
        process: "archive-session",
    };
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let generations::Admission::New(receipt) =
        generations::begin_rows(&tx, scope, &"f".repeat(32), &"d".repeat(64)).unwrap()
    else {
        panic!("new original generation")
    };
    let display = archive::DisplayMessage {
        text: "Recovered visible question".into(),
        addressed_label: None,
        attachment_refs: Vec::new(),
    };
    archive::begin_rows(
        &tx,
        scope,
        &receipt,
        &archive::AttemptBinding {
            thread_id: "selected-thread".into(),
            user_message_id: "selected-user".into(),
            assistant_message_id: "selected-answer".into(),
            parent_thread_id: None,
            branch_message_id: None,
            display_message: display.clone(),
        },
        100,
    )
    .unwrap();
    // Original CLI session capture is absent, while its separately registered
    // ACT native owner has closed. Closure does not settle retained effects.
    tx.execute(
        "UPDATE chat_generation_runs SET state='completed' WHERE run_id=?1",
        [&receipt.current_run_id],
    )
    .unwrap();
    tx.execute(
        "UPDATE chat_generations SET state='completed' WHERE generation_id=?1",
        [&receipt.generation_id],
    )
    .unwrap();
    archive::settle_rows(
        &tx,
        scope,
        &receipt.generation_id,
        &receipt.current_run_id,
        1000,
    )
    .unwrap();
    tx.execute("INSERT INTO runs(run_id,vault_id,store_uuid,mode,lane,started_at,ended_at,outcome,usage_state,input_tokens,output_tokens,cache_read,cache_write,reserved_total_tokens,reserved_output_tokens,proposals_submitted,applied,rejected,actor,cli_session_id) VALUES(?1,?2,'store','attended',(SELECT lane FROM lane_registry LIMIT 1),?3,?3,'succeeded','unknown',0,0,0,0,0,0,0,0,0,'human:me','12345678-1234-1234-1234-123456789abc')",rusqlite::params![receipt.current_run_id,VAULT,STAMP]).unwrap();
    tx.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,admitted_at,closed_at,close_kind) VALUES(?1,?2,1,?3,'store','/chat-retention-fixture','human:me','human:me','run','archive-session','12345678-1234-1234-1234-123456789abc',?4,?4,'completed')",rusqlite::params![receipt.current_run_id,"b".repeat(32),VAULT,STAMP]).unwrap();
    let effect_scope = ActionSubjectView {
        vault_id: VAULT.into(),
        run_id: receipt.current_run_id.clone(),
        actor_id: "human:me".into(),
        child_job_id: None,
        client_id: None,
    };
    let mut value = effect_record::tests::fixture(&effect_scope, 2);
    value["details"]["effect"]["state"] = serde_json::json!("dispatched");
    value["details"]["effect"]["canRetry"] = serde_json::json!(false);
    value["details"]["effect"]["canReconcile"] = serde_json::json!(false);
    value["details"]["attempts"][0]["state"] = serde_json::json!("dispatched");
    tx.execute("INSERT INTO action_invocations(invocation_id,subject_scope,request_key,request_digest,revision,state,payload) VALUES(?1,?2,?3,?4,1,'dispatched',?5)",rusqlite::params![format!("{:032x}",2),effect_record::scope_key(&effect_scope).unwrap(),value["request"]["requestKey"].as_str().unwrap(),value["request_digest"].as_str().unwrap(),value.to_string()]).unwrap();
    assert_eq!(
        active_owners(&tx, VAULT, "store", &receipt.current_run_id, "human:me"),
        Ok(vec![format!("{:032x}", 2)]),
        "existing ACT reader keeps closed but dispatched effects active"
    );
    let session: Option<String> = tx
        .query_row(
            "SELECT cli_session_id FROM chat_generation_runs WHERE run_id=?1",
            [&receipt.current_run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(session.is_none());
    assert!(
        matches!(
            archive::retention::delete_rows(&tx, scope, "selected-thread", 2000).unwrap(),
            archive::retention::DeleteResult::BlockedActive { .. }
        ),
        "original delete guard already inspects linked owners without relying on CLI capture"
    );
    archive::retention::set_rows(&tx, scope, archive::RetentionChoice::Forever, 0).unwrap();
    let selected = ImportBatch {
        source_vault_path: "/chat-retention-fixture".into(),
        thread_id: "selected-thread".into(),
        attempts: vec![LegacyAttempt {
            user_message_id: "selected-user".into(),
            assistant_message_id: "selected-answer".into(),
            display_message: display,
            answer: ArchiveTurnV1 {
                version: 1,
                blocks: vec![Block::Text {
                    message_id: "final".into(),
                    text: "Recovered visible answer".into(),
                }],
                availability: Availability::Partial,
                references: Vec::new(),
                last_uuid: None,
            },
            completed_at: None,
            session_id: None,
        }],
    };
    let result = archive::legacy::import_rows(&tx, scope, &selected, 2000).unwrap();
    assert!(
        matches!(
            result.as_slice(),
            [ImportItem::Skipped {
                reason: ImportSkip::BlockedActive,
                ..
            }]
        ),
        "closed linked ACT effects must block import even without a captured chat session"
    );
    assert_eq!(
        tx.query_row(
            "SELECT count(*) FROM conversation_legacy_content",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let original: (String, i64) = tx
        .query_row(
            "SELECT archive_state,completed_at FROM conversation_bindings WHERE generation_id=?1",
            [&receipt.generation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(original, ("off".into(), 1000));
    tx.rollback().unwrap();
}
