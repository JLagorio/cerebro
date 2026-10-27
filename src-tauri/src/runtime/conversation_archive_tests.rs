//! Existing generation settlement is the production subject: no alternate reducer,
//! mock writer, provider, credential, webview or session-file execution.
use super::*;
use rusqlite::{Transaction, TransactionBehavior};
const KEY: &str = "11111111111111111111111111111111";
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION: &str = "12345678-1234-1234-1234-123456789abc";
fn scope() -> Scope<'static> {
    Scope {
        owner: "human:me",
        vault: "cccccccccccccccccccccccccccccccc",
        store: "store",
        actor: "claude-code",
        process: "process-one",
    }
}
fn tx<T>(
    conn: &Connection,
    work: impl FnOnce(&Connection) -> Result<T, Error>,
) -> Result<T, Error> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).unwrap();
    let value = work(&tx)?;
    tx.commit().unwrap();
    Ok(value)
}
fn setup() -> (Connection, Receipt) {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    conn.execute_batch("CREATE TABLE vault_registry(vault_id TEXT PRIMARY KEY);INSERT INTO vault_registry VALUES('cccccccccccccccccccccccccccccccc');").unwrap();
    conn.execute_batch(crate::runtime::schema::SCHEMA_V42)
        .unwrap();
    conn.execute_batch(crate::runtime::schema::SCHEMA_V49)
        .unwrap();
    conn.execute_batch(crate::runtime::schema::SCHEMA_V50)
        .unwrap();
    conn.execute("INSERT INTO conversation_retention(owner_person,vault_id,store_uuid,choice) VALUES('human:me',?1,'store','days90')",[scope().vault]).unwrap();
    let Admission::New(receipt) = tx(&conn, |c| begin_rows(c, scope(), KEY, DIGEST)).unwrap()
    else {
        panic!("new generation")
    };
    let binding = crate::runtime::conversations::AttemptBinding {
        thread_id: "thread".into(),
        user_message_id: "user".into(),
        assistant_message_id: "assistant".into(),
        parent_thread_id: None,
        branch_message_id: None,
        display_message: crate::runtime::conversations::DisplayMessage {
            text: "VISIBLE_QUESTION".into(),
            addressed_label: None,
            attachment_refs: Vec::new(),
        },
    };
    tx(&conn, |c| {
        crate::runtime::conversations::begin_rows(c, scope(), &receipt, &binding, 1)
    })
    .unwrap();
    tx(&conn, |c| {
        bind_session_rows(c, scope(), &receipt.current_run_id, SESSION)
    })
    .unwrap();
    (conn, receipt)
}
fn archived(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM conversation_content", [], |r| {
        r.get(0)
    })
    .unwrap()
}
#[test]
fn conversations_terminal_failure_without_webview_archives_frozen_question() {
    let (conn, r) = setup();
    tx(&conn, |c| {
        finish_rows(c, scope(), &r.current_run_id, End::Failed)
    })
    .unwrap();
    assert_eq!(
        archived(&conn),
        1,
        "terminal Rust settlement must archive even without webview/session file"
    );
    let content: String = conn
        .query_row("SELECT content_json FROM conversation_content", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(content.contains("VISIBLE_QUESTION"));
}
#[test]
fn conversations_deferred_process_is_not_completed_content() {
    let (conn, r) = setup();
    tx(&conn, |c| {
        finish_rows(c, scope(), &r.current_run_id, End::Deferred)
    })
    .unwrap();
    assert_eq!(archived(&conn), 0);
}
#[test]
fn conversations_resumed_terminal_settlement_archives_once_under_original_attempt() {
    let (conn, r) = setup();
    tx(&conn, |c| {
        finish_rows(c, scope(), &r.current_run_id, End::Deferred)
    })
    .unwrap();
    let Some(Admission::New(next)) = tx(&conn, |c| {
        resume_rows(
            c,
            scope(),
            &r.current_run_id,
            SESSION,
            "22222222222222222222222222222222",
        )
    })
    .unwrap() else {
        panic!("resume")
    };
    tx(&conn, |c| {
        bind_session_rows(c, scope(), &next.current_run_id, SESSION)
    })
    .unwrap();
    tx(&conn, |c| {
        finish_rows(c, scope(), &next.current_run_id, End::Completed)
    })
    .unwrap();
    tx(&conn, |c| {
        finish_rows(c, scope(), &next.current_run_id, End::Completed)
    })
    .unwrap();
    assert_eq!(
        archived(&conn),
        1,
        "one original generation, one archive admission"
    );
    let generation: String = conn
        .query_row("SELECT generation_id FROM conversation_content", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(generation, r.generation_id);
}
#[test]
fn conversations_off_before_terminal_settlement_retains_no_completed_body() {
    let (conn, r) = setup();
    conn.execute("UPDATE conversation_retention SET choice='off'", [])
        .unwrap();
    tx(&conn, |c| {
        finish_rows(c, scope(), &r.current_run_id, End::Completed)
    })
    .unwrap();
    assert_eq!(archived(&conn), 0);
    let pending: i64 = conn
        .query_row(
            "SELECT count(*) FROM conversation_bindings WHERE display_json IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        pending, 0,
        "Off must clear active recovery question on settlement"
    );
}

#[test]
fn conversations_fast_resume_cannot_claim_complete_when_original_segment_is_unproven() {
    use crate::agent::archive_codec::{ArchiveTurnV1, Availability, Block};
    let (conn, original) = setup();
    let Some(Admission::New(resumed)) = tx(&conn, |conn| {
        resume_rows(
            conn,
            scope(),
            &original.current_run_id,
            SESSION,
            "22222222222222222222222222222222",
        )
    })
    .unwrap() else {
        panic!("resume")
    };
    // The new current member can finish before the original reader returns.
    let after = ArchiveTurnV1 {
        version: 1,
        blocks: vec![Block::Text {
            message_id: "resumed-answer".into(),
            text: "After the held answer".into(),
        }],
        availability: Availability::Complete,
        references: Vec::new(),
        last_uuid: None,
    };
    tx(&conn, |conn| {
        bind_session_rows(conn, scope(), &resumed.current_run_id, SESSION)
    })
    .unwrap();
    tx(&conn, |conn| {
        crate::runtime::conversations::stage_rows(conn, scope(), &resumed.current_run_id, &after)?;
        finish_rows(conn, scope(), &resumed.current_run_id, End::Completed)
    })
    .unwrap();
    let before = ArchiveTurnV1 {
        version: 1,
        blocks: vec![Block::Text {
            message_id: "original-narration".into(),
            text: "Before the held answer".into(),
        }],
        availability: Availability::Complete,
        references: Vec::new(),
        last_uuid: None,
    };
    tx(&conn, |conn| {
        crate::runtime::conversations::stage_rows(
            conn,
            scope(),
            &original.current_run_id,
            &before,
        )?;
        finish_rows(conn, scope(), &original.current_run_id, End::Deferred)
    })
    .unwrap();
    let content: String = conn
        .query_row("SELECT content_json FROM conversation_content", [], |row| {
            row.get(0)
        })
        .unwrap();
    let content: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(
        content["answer"]["availability"], "partial",
        "missing original segment must never be a complete archived attempt"
    );
    assert!(content.to_string().contains("After the held answer"));
    assert!(
        !content.to_string().contains("Before the held answer"),
        "late members cannot rewrite immutable completed content"
    );
    assert_eq!(archived(&conn), 1);
}
